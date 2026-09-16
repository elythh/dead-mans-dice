# Dead Man's Dice

Liar's Dice — the game Bootstrap Bill teaches Will Turner aboard the Flying
Dutchman in *Dead Man's Chest* — for 2-8 players over the web. Self-hosted:
one small Node process, no database, no accounts. A room is a 4-letter code;
friends open your server's URL, enter the code, and play from their own
phones or laptops. Each player's dice are only known to them (and the
server) until someone calls "Liar!" or dares "Spot on!".

## Rules implemented

- Everyone starts with 5 dice, rolled privately each round.
- Ones are wild (count toward any bid except a bid on ones itself).
- On your turn: raise the bid (higher quantity, or same quantity on a
  higher face), call **Liar!**, or dare **Spot on!**.
- Liar wrong → bidder loses a die. Liar right → challenger loses a die.
- Spot on right → everyone else loses a die. Spot on wrong → caller loses
  a die.
- Whoever loses a die opens the next round. Run out of dice, you're out.
  Last sailor standing wins.

## Run it locally

```bash
npm install
npm start
# open http://localhost:8080
```

`PORT` env var overrides the default port 8080.

### With Nix

A flake is included, so with Nix (flakes enabled) you don't need `npm`
at all:

```bash
nix run .          # builds (first time only) and starts the server on :8080
PORT=8080 nix run . # same, explicit port
nix develop         # drops you into a shell with Node.js for `npm`/`node` commands
nix build .         # builds ./result/bin/dead-mans-dice, a standalone launcher
```

`nix run` packages `server.js`, `public/`, and its one dependency (`ws`)
into the Nix store, so the built package is self-contained — copy the
repo to the VPS and `nix run .` (or point a systemd unit at
`nix build`'s `./result/bin/dead-mans-dice`) without an `npm install` step.

## Deploy on your VPS

1. Copy this folder to the server (git clone, or `scp -r`).
2. `npm install --omit=dev` (skip this if using the Nix flake above).
3. Run it under a process manager so it survives reboots/crashes. With
   **systemd**, create `/etc/systemd/system/dead-mans-dice.service`:

   ```ini
   [Unit]
   Description=Dead Man's Dice
   After=network.target

   [Service]
   WorkingDirectory=/opt/dead-mans-dice
   ExecStart=/usr/bin/node server.js
   Environment=PORT=8080
   Restart=always
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   Then: `systemctl daemon-reload && systemctl enable --now dead-mans-dice`.

   (Or use `pm2 start server.js --name dead-mans-dice` if you prefer pm2.)

4. Put it behind a reverse proxy for TLS and a real domain — the game
   needs WebSockets to pass through, so make sure the `Upgrade` header is
   forwarded. Nginx example:

   ```nginx
   server {
     listen 443 ssl;
     server_name dice.example.com;

     ssl_certificate     /etc/letsencrypt/live/dice.example.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/dice.example.com/privkey.pem;

     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```

   Get a certificate with `certbot --nginx -d dice.example.com`.

5. Open the firewall for 80/443 only (keep 8080 internal-only — don't
   expose it directly, let nginx be the only public entry point).

Send friends `https://dice.example.com`. Whoever creates a room becomes
the captain and can start the game once at least one other player has
joined; that link/room code is shareable with anyone who can reach your
domain.

## Notes on the implementation

- State lives in memory on the server (`server.js`'s `rooms` map) — a
  restart clears in-progress games. That's intentional: no database to
  run or back up.
- Reconnects: the browser keeps a room code + player token in
  `localStorage` and rejoins automatically if the connection drops or the
  page reloads.
- Idle rooms (every player disconnected) are swept after 45 minutes.
