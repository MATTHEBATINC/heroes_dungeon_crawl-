#!/usr/bin/env node
/*
 * 8-Bit Heroes online server  (no dependencies - just Node 16+)
 *
 *   node server.js          -> http://localhost:8080
 *   PORT=3000 node server.js
 *
 * It does four jobs:
 *   1. Serves the game page (index.html in this folder) so friends can just open your address.
 *   2. Keeps the list of usernames (unique, filtered) and friend lists in data.json.
 *   3. Tracks who is online, friend requests, game invites and the random matchmaking queue.
 *   4. Relays game messages between the two players of a match.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- Username rules (identical on the server and in the game) ----
const NAME_MIN = 3, NAME_MAX = 16;
// Safe to match anywhere inside a name (very unlikely to appear in an innocent word)
const BAD_SUBSTRINGS = [
    'fuck','fuk','shit','bitch','cunt','nigg','fagg','whore','slut','nazi','hitler','porn','penis','vagina',
    'dildo','blowjob','handjob','jizz','pussy','asshole','retard','tranny','molest','paedo','hentai','orgasm',
    'masturb','killyourself','kkk','jihad','suicide','genocide','rapist','chink','blowme','cumshot','erotic',
    'incest','childporn','nudes','whitepower','gaskids','kidnap','school shoot','schoolshoot','bomber'
];
// Words that are only blocked when they are a whole "word" in the name (e.g. ass_99, Sex, dick)
const BAD_WORDS = [
    'ass','arse','sex','anus','anal','dick','cock','tit','tits','boob','boobs','coon','spic','fag','kys','pedo',
    'heil','isis','nude','cum','kike','rape','loli','xxx','hoe','thot','milf','orgy','69','pee','poop','fart',
    'nipple','vape','weed','meth','drugs','kill','murder','die','dead','sus','sussy','amogus','sugondese','deez'
];
// Names that could be mistaken for staff / the game itself
const RESERVED_WORDS = [
    'admin','administrator','moderator','mod','staff','system','server','support','owner','official','anthropic',
    'claude','null','undefined','guest','player','user','test','root','host','god','everyone','nobody','you'
];
const RESERVED_PREFIXES = ['admin','moderator','anthropic','official','staff'];

function usernameKey(name) {
    // Case-insensitive, and look-alikes (B0b / Bob, l1l / lil) count as the same name
    return String(name).toLowerCase().replace(/_/g, '').replace(/0/g, 'o').replace(/1/g, 'l').replace(/[i]/g, 'l');
}

function usernameVariants(name) {
    const lower = name.toLowerCase();
    const maps = [
        { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','9':'g' },
        { '0':'o','1':'l','3':'e','4':'a','5':'s','7':'t','8':'b','9':'g' }
    ];
    const out = new Set();
    maps.forEach(m => {
        const leet = lower.replace(/[0-9]/g, d => m[d] || d);
        out.add(leet.replace(/_/g, ''));
        out.add(leet.replace(/_/g, '').replace(/(.)\1+/g, '$1'));
        out.add(lower.replace(/[^a-z]/g, ''));
    });
    return [...out];
}

function usernameWords(name) {
    // split on underscores and letter/digit boundaries: "Ass_99xX" -> ass, 99, xx
    return name.toLowerCase().split(/_|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean);
}

function validateUsername(raw) {
    const name = String(raw == null ? '' : raw).trim();
    const nope = "That username isn't allowed. Please pick something friendlier.";
    if (name.length < NAME_MIN) return { ok: false, reason: `Usernames need at least ${NAME_MIN} characters.` };
    if (name.length > NAME_MAX) return { ok: false, reason: `Usernames can be at most ${NAME_MAX} characters.` };
    if (!/^[A-Za-z0-9_]+$/.test(name)) return { ok: false, reason: 'Only letters, numbers and underscores are allowed.' };
    if (/^_|_$|__/.test(name)) return { ok: false, reason: 'No leading, trailing or double underscores.' };
    if (!/[A-Za-z]{3}/.test(name)) return { ok: false, reason: 'Use at least three letters in a row.' };
    if (/(.)\1{3,}/i.test(name)) return { ok: false, reason: 'Too many repeated characters in a row.' };
    if (/\d{5,}/.test(name)) return { ok: false, reason: 'Too many digits in a row.' };
    const lettersOnly = name.toLowerCase().replace(/[^a-z]/g, '');
    if (/[^aeiouy]{7,}/.test(lettersOnly)) return { ok: false, reason: 'That looks like random keyboard mashing.' };
    if (name.length >= 6 && new Set(name.toLowerCase().split('')).size <= 2) return { ok: false, reason: nope };
    if (/(..+)\1{2,}/i.test(name)) return { ok: false, reason: nope }; // "lololol", "abababab"

    const variants = usernameVariants(name);
    for (const v of variants) {
        for (const bad of BAD_SUBSTRINGS) if (v.includes(bad.replace(/\s/g, ''))) return { ok: false, reason: nope };
    }
    const words = usernameWords(name);
    const wordVariants = new Set(words);
    words.forEach(w => usernameVariants(w).forEach(v => wordVariants.add(v)));
    for (const w of wordVariants) if (BAD_WORDS.includes(w)) return { ok: false, reason: nope };
    for (const v of variants) if (BAD_WORDS.includes(v)) return { ok: false, reason: nope };
    const joined = name.toLowerCase().replace(/_/g, '');
    if (RESERVED_WORDS.includes(joined) || words.some(w => RESERVED_WORDS.includes(w) && words.length === 1)) return { ok: false, reason: 'That name is reserved.' };
    if (RESERVED_PREFIXES.some(p => joined.startsWith(p))) return { ok: false, reason: 'That name is reserved.' };
    return { ok: true, name };
}


// ---------------------------------------------------------------- storage
// Usernames and friendships are saved in up to three places so they survive restarts:
//   1. data.json next to the server (or DATA_FILE)
//   2. an optional free cloud store (Upstash Redis) when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set
//   3. each player's browser remembers their friends and re-teaches the server (see "claims" below)
let users = {};   // usernameKey -> { name, token, friends:[key], incoming:[key], outgoing:[key] }
const claimsMap = new Map();   // usernameKey -> Set(usernameKey): friends a player's browser says they have (memory only)
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UP_KEY = process.env.UPSTASH_KEY || 'bh_users';

async function upstash(cmd) {
    const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
}
async function loadStore() {
    try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).users || {}; } catch (e) { users = {}; }
    if (UP_URL && UP_TOKEN) {
        try {
            const v = await upstash(['GET', UP_KEY]);
            if (v) { const remote = JSON.parse(v).users || {}; if (Object.keys(remote).length) users = remote; }
            console.log('Cloud store connected (Upstash).');
        } catch (e) { console.error('Could not load from the cloud store:', e.message); }
    }
    console.log(`Loaded ${Object.keys(users).length} player(s).`);
}
let saving = Promise.resolve();
function saveNow() {
    const json = JSON.stringify({ users });
    try { fs.writeFileSync(DATA_FILE + '.tmp', json); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { /* read-only disk is fine if the cloud store is on */ }
    if (UP_URL && UP_TOKEN) saving = saving.then(() => upstash(['SET', UP_KEY, json])).catch(e => console.error('Cloud save failed:', e.message));
    return saving;
}
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
async function shutdown() { clearTimeout(saveTimer); await saveNow(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------- http (serves the game)
function findGameFile() {
    if (process.env.GAME_FILE) return process.env.GAME_FILE;
    const idx = path.join(__dirname, 'index.html');
    if (fs.existsSync(idx)) return idx;
    const any = fs.readdirSync(__dirname).find(f => f.endsWith('.html'));
    return any ? path.join(__dirname, any) : null;
}
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
        const f = findGameFile();
        if (!f) { res.writeHead(404); return res.end('Put the game file (index.html) next to server.js'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(f).pipe(res);
    }
    if (url === '/health') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(404); res.end('Not found');
});

// ---------------------------------------------------------------- tiny WebSocket implementation
function frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
}

class Client {
    constructor(socket) {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.fragments = [];
        this.fragOpcode = 0;
        this.user = null;        // usernameKey once logged in
        this.status = 'menu';    // menu | queue | ingame
        this.partner = null;
        this.role = null;
        this.inviteTo = null;    // usernameKey I have invited
        this.alive = true;
        socket.on('data', d => this.onData(d));
        socket.on('close', () => this.onClose());
        socket.on('error', () => this.onClose());
    }
    send(obj) {
        if (!this.alive) return;
        try { this.socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); } catch (e) {}
    }
    onData(d) {
        this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 2) {
            const b0 = this.buf[0], b1 = this.buf[1];
            const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
            let len = b1 & 0x7f, off = 2;
            if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
            if (len > 2 * 1024 * 1024) return this.close();
            const need = off + (masked ? 4 : 0) + len;
            if (this.buf.length < need) return;
            let payload = this.buf.slice(off + (masked ? 4 : 0), need);
            if (masked) {
                const mask = this.buf.slice(off, off + 4);
                payload = Buffer.from(payload);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            this.buf = this.buf.slice(need);
            if (opcode === 8) return this.close();
            if (opcode === 9) { this.socket.write(frame(10, payload)); continue; }
            if (opcode === 10) continue;
            if (opcode === 1 || opcode === 2) { this.fragments = [payload]; this.fragOpcode = opcode; }
            else if (opcode === 0) this.fragments.push(payload);
            if (fin && (opcode === 0 || opcode === 1 || opcode === 2)) {
                const text = Buffer.concat(this.fragments).toString('utf8');
                this.fragments = [];
                let msg; try { msg = JSON.parse(text); } catch (e) { continue; }
                try { handle(this, msg); } catch (e) { console.error('handler error', e); }
            }
        }
    }
    close() { try { this.socket.write(frame(8, Buffer.alloc(0))); } catch (e) {} try { this.socket.end(); } catch (e) {} this.onClose(); }
    onClose() {
        if (!this.alive) return;
        this.alive = false;
        disconnect(this);
    }
}

server.on('upgrade', (req, socket) => {
    if (req.url.split('?')[0] !== '/ws' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    new Client(socket);
});
setInterval(() => { sessions.forEach(c => { try { c.socket.write(frame(9, Buffer.alloc(0))); } catch (e) {} }); }, 25000);

// ---------------------------------------------------------------- sessions, social, matchmaking
const sessions = new Map();   // usernameKey -> Client
let queue = [];               // Clients waiting for a random partner

function nameOf(key) { return users[key] ? users[key].name : key; }
function statusOf(key) {
    const c = sessions.get(key);
    return c ? c.status : 'offline';
}
function socialFor(key) {
    const u = users[key];
    return {
        t: 'social',
        me: u.name,
        friends: u.friends.map(k => ({ name: nameOf(k), status: statusOf(k) })).sort((a, b) => (a.status === 'offline') - (b.status === 'offline') || a.name.localeCompare(b.name)),
        incoming: u.incoming.map(nameOf),
        outgoing: u.outgoing.map(nameOf)
    };
}
function pushSocial(key) { const c = sessions.get(key); if (c && users[key]) c.send(socialFor(key)); }
function pushPresence(key) {   // tell my friends my status changed
    const u = users[key]; if (!u) return;
    u.friends.forEach(pushSocial);
}
function toast(c, msg, kind) { c.send({ t: 'toast', msg, kind: kind || 'info' }); }
function loginClient(c, key) {
    const old = sessions.get(key);
    if (old && old !== c) { old.send({ t: 'kicked' }); old.user = null; disconnectClean(old); }
    c.user = key; c.status = 'menu';
    sessions.set(key, c);
    c.send(socialFor(key));
    pushPresence(key);
}
function leaveQueue(c) { queue = queue.filter(x => x !== c); }
function cancelInvite(c) {
    if (c.inviteTo) {
        const t = sessions.get(c.inviteTo);
        if (t) t.send({ t: 'inviteCancelled', from: nameOf(c.user) });
        c.inviteTo = null;
    }
}
function startMatch(host, guest, mode) {
    leaveQueue(host); leaveQueue(guest);
    cancelInvite(host); cancelInvite(guest);
    host.status = guest.status = 'ingame';
    host.partner = guest; guest.partner = host;
    host.role = 'host'; guest.role = 'guest';
    host.send({ t: 'matchFound', role: 'host', partner: nameOf(guest.user), mode });
    guest.send({ t: 'matchFound', role: 'guest', partner: nameOf(host.user), mode });
    pushPresence(host.user); pushPresence(guest.user);
}
function endMatch(c, notify) {
    const p = c.partner;
    c.partner = null; c.role = null;
    if (c.status === 'ingame') c.status = 'menu';
    if (p) {
        p.partner = null; p.role = null;
        if (p.status === 'ingame') p.status = 'menu';
        if (notify) p.send({ t: 'partnerLeft', name: c.user ? nameOf(c.user) : '' });
        if (p.user) pushPresence(p.user);
    }
    if (c.user) pushPresence(c.user);
}
function disconnectClean(c) { leaveQueue(c); cancelInvite(c); if (c.partner) endMatch(c, true); }
function disconnect(c) {
    disconnectClean(c);
    if (c.user && sessions.get(c.user) === c) {
        const key = c.user;
        sessions.delete(key);
        pushPresence(key);
    }
}

function requireLogin(c) { if (!c.user || !users[c.user]) { c.send({ t: 'needLogin' }); return false; } return true; }

function handle(c, m) {
    switch (m.t) {
        case 'check': {
            const v = validateUsername(m.name);
            if (!v.ok) return c.send({ t: 'checkResult', name: m.name, ok: false, reason: v.reason });
            const taken = !!users[usernameKey(v.name)];
            return c.send({ t: 'checkResult', name: m.name, ok: !taken, reason: taken ? 'That username is already taken.' : '' });
        }
        case 'register': {
            const v = validateUsername(m.name);
            if (!v.ok) return c.send({ t: 'registerResult', ok: false, reason: v.reason });
            if (typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 80) return c.send({ t: 'registerResult', ok: false, reason: 'Bad token.' });
            const key = usernameKey(v.name);
            if (users[key]) return c.send({ t: 'registerResult', ok: false, reason: 'That username is already taken.' });
            users[key] = { name: v.name, token: m.token, friends: [], incoming: [], outgoing: [] };
            saveSoon();
            c.send({ t: 'registerResult', ok: true, name: v.name });
            return loginClient(c, key);
        }
        case 'login': {
            const key = usernameKey(m.name || '');
            const u = users[key];
            if (!u) return c.send({ t: 'loginResult', ok: false, reason: 'unknown' });
            if (u.token !== m.token) return c.send({ t: 'loginResult', ok: false, reason: 'badtoken' });
            c.send({ t: 'loginResult', ok: true, name: u.name });
            return loginClient(c, key);
        }
        case 'friendRequest': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || '');
            const target = users[tk];
            if (!target) return toast(c, `No player named "${String(m.name).slice(0, 20)}" exists.`, 'error');
            if (tk === me) return toast(c, "You can't friend yourself.", 'error');
            const mine = users[me];
            if (mine.friends.includes(tk)) return toast(c, `You and ${target.name} are already friends.`, 'error');
            if (mine.outgoing.includes(tk)) return toast(c, `You already sent ${target.name} a request.`, 'error');
            if (mine.incoming.includes(tk)) {   // they already asked me: accept
                mine.incoming = mine.incoming.filter(k => k !== tk); target.outgoing = target.outgoing.filter(k => k !== me);
                mine.friends.push(tk); target.friends.push(me);
                saveSoon(); pushSocial(me); pushSocial(tk);
                toast(c, `You and ${target.name} are now friends!`, 'good');
                const t = sessions.get(tk); if (t) toast(t, `${mine.name} accepted your friend request!`, 'good');
                return;
            }
            mine.outgoing.push(tk); target.incoming.push(me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            toast(c, `Friend request sent to ${target.name}.`, 'good');
            const t = sessions.get(tk); if (t) toast(t, `${mine.name} sent you a friend request!`, 'info');
            return;
        }
        case 'friendAccept': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || ''), mine = users[me], other = users[tk];
            if (!other || !mine.incoming.includes(tk)) return toast(c, 'That request is no longer there.', 'error');
            mine.incoming = mine.incoming.filter(k => k !== tk); other.outgoing = other.outgoing.filter(k => k !== me);
            if (!mine.friends.includes(tk)) mine.friends.push(tk);
            if (!other.friends.includes(me)) other.friends.push(me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            toast(c, `You and ${other.name} are now friends!`, 'good');
            const t = sessions.get(tk); if (t) toast(t, `${mine.name} accepted your friend request!`, 'good');
            return;
        }
        case 'friendDecline': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || ''), mine = users[me], other = users[tk];
            mine.incoming = mine.incoming.filter(k => k !== tk);
            if (other) other.outgoing = other.outgoing.filter(k => k !== me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            return;
        }
        case 'claims': {
            // After a server reset the browsers re-teach us who is friends with whom.
            // A friendship is only restored when BOTH players' browsers claim each other.
            if (!requireLogin(c)) return;
            const me = c.user, mine = users[me];
            const set = new Set((Array.isArray(m.names) ? m.names : []).slice(0, 500).map(n => usernameKey(String(n))));
            claimsMap.set(me, set);
            let changed = false;
            set.forEach(k => {
                const other = users[k];
                if (k === me || !other) return;
                const theirs = claimsMap.get(k);
                if ((theirs && theirs.has(me)) || other.friends.includes(me)) {
                    if (!mine.friends.includes(k)) { mine.friends.push(k); changed = true; }
                    if (!other.friends.includes(me)) { other.friends.push(me); changed = true; }
                    mine.incoming = mine.incoming.filter(x => x !== k); mine.outgoing = mine.outgoing.filter(x => x !== k);
                    other.incoming = other.incoming.filter(x => x !== me); other.outgoing = other.outgoing.filter(x => x !== me);
                }
            });
            if (changed) { saveSoon(); pushSocial(me); set.forEach(pushSocial); }
            return;
        }
        case 'friendRemove': {
            if (!requireLogin(c)) return;
            const me = c.user, tk = usernameKey(m.name || ''), mine = users[me], other = users[tk];
            mine.friends = mine.friends.filter(k => k !== tk);
            if (other) other.friends = other.friends.filter(k => k !== me);
            if (claimsMap.get(me)) claimsMap.get(me).delete(tk);
            if (claimsMap.get(tk)) claimsMap.get(tk).delete(me);
            saveSoon(); pushSocial(me); pushSocial(tk);
            return;
        }
        case 'queueJoin': {
            if (!requireLogin(c) || c.status !== 'menu') return;
            cancelInvite(c);
            c.status = 'queue'; queue.push(c);
            pushPresence(c.user);
            if (queue.length >= 2) {
                const a = queue.shift(), b = queue.shift();
                startMatch(a, b, 'random');
            }
            return;
        }
        case 'queueLeave': {
            if (!c.user) return;
            if (c.status === 'queue') { leaveQueue(c); c.status = 'menu'; pushPresence(c.user); }
            return;
        }
        case 'invite': {
            if (!requireLogin(c) || c.status !== 'menu') return;
            const tk = usernameKey(m.name || ''), mine = users[c.user];
            if (!mine.friends.includes(tk)) return c.send({ t: 'inviteResult', ok: false, reason: 'You can only invite friends.' });
            const t = sessions.get(tk);
            if (!t) return c.send({ t: 'inviteResult', ok: false, reason: `${nameOf(tk)} is offline.` });
            if (t.status !== 'menu') return c.send({ t: 'inviteResult', ok: false, reason: `${nameOf(tk)} is busy right now.` });
            cancelInvite(c);
            c.inviteTo = tk;
            t.send({ t: 'inviteReceived', from: mine.name });
            c.send({ t: 'inviteResult', ok: true, name: nameOf(tk) });
            return;
        }
        case 'inviteCancel': { if (c.user) cancelInvite(c); return; }
        case 'inviteRespond': {
            if (!requireLogin(c)) return;
            const ik = usernameKey(m.name || ''), inviter = sessions.get(ik);
            if (!inviter || inviter.inviteTo !== c.user) return toast(c, 'That invite is no longer valid.', 'error');
            if (!m.accept) {
                inviter.inviteTo = null;
                inviter.send({ t: 'inviteDeclined', by: nameOf(c.user) });
                return;
            }
            if (c.status !== 'menu' || inviter.status !== 'menu') return toast(c, 'That invite is no longer valid.', 'error');
            inviter.inviteTo = null;
            startMatch(inviter, c, 'friend');
            return;
        }
        case 'game': {
            if (c.partner && c.partner.alive) c.partner.send({ t: 'game', data: m.data });
            return;
        }
        case 'leaveMatch': { if (c.partner || c.status === 'ingame') endMatch(c, true); return; }
    }
}

loadStore().then(() => server.listen(PORT, () => {
    console.log(`8-Bit Heroes server running on http://localhost:${PORT}`);
    console.log('Share this address (or your public URL) with friends so they can play online with you.');
}));
