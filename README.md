# 🎵 Spotify Vinyl Player - Python Edition

A stylish, interactive desktop application that brings your **Spotify** playback to life with a retro vinyl record animation. This project uses Python to fetch real-time data from Spotify and displays it on a dynamic GUI whose background is built from the album cover's colors.

---

##  Overview
This application connects to your Spotify account and:
* **Tracks Live Music**: Detects what you are currently listening to.
* **Dynamic Visuals**: Downloads album art and transforms it into a rotating vinyl sticker.
* **Immersive UI**: A grainy gradient of the current album cover's main colors, with fine fingerprint-like rings spreading out from the record.
* **Animated Elements**: Includes a spinning vinyl record and a classic record player arm.

---

##  Features
*  **Realistic turntable**: vinyl with fine grooves, track gaps and a fixed light reflection; a metal tonearm that lifts, swings and drops onto the record and moves inward as the song plays.
*  **Sharp on any screen**: everything is drawn as vectors at native resolution (Retina, full screen, any window size).
*  **Always readable**: the song title auto-fits its size and sits on an adaptive dark veil with a soft shadow; Hebrew and other RTL names are supported.
*  **Never freezes**: Spotify is polled in the background; expired logins and network drops are handled on screen.
*  **Keys**: `F` / double-click full screen · `T` always on top · `Esc` leave full screen.

---

##  Tech Stack
* **Language:** Python 3.10+
* **GUI Framework:** Qt (`PySide6`)
* **API:** [Spotipy](https://spotipy.readthedocs.io/) (Spotify Web API wrapper)
* **Image Handling:** `Pillow` (PIL)

---

##  Running it
* **Double-click `Vinyl Player.command`** — the first run installs everything automatically.
* **Install as a Mac app**: run `./install_app.sh`. It adds *Vinyl Player* to `~/Applications` and starts a small background helper, so the player pops up on top whenever Spotify opens (and hides when Spotify quits). Use `--no-auto` for the app only, `--uninstall` to remove everything. Right-click the player for *Always on top* / *Quit*.
* **Try it without Spotify**: `./"Vinyl Player.command" --demo`
* On first launch click the window to connect Spotify; the login is remembered afterwards.

---

##  Preview
![Record Player](./record.gif)


##  Prerequisites & Setup

1. **Spotify Developer Account:**
   * Create an app on the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
   * Set the Redirect URI to: `https://github.com/lorenkr/spotify-turntable/blob/main/docs/callback.html`

2. **Environment Variables:**
   Create a `.env` file in the root directory and add your credentials:
   ```env
   CLIENT_ID=your_client_id_here
   CLIENT_SECRET=your_client_secret_here


   
