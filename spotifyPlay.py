"""Thin wrapper around Spotipy: authentication + "what's playing now"."""
import os
from pathlib import Path

from dotenv import load_dotenv
import spotipy
from spotipy.cache_handler import CacheFileHandler
from spotipy.oauth2 import SpotifyOAuth, SpotifyOauthError

APP_DIR = Path(__file__).resolve().parent
load_dotenv(APP_DIR / ".env")

# Must match the Redirect URI set in the Spotify Developer Dashboard.
# Can be overridden with REDIRECT_URI in .env.
DEFAULT_REDIRECT_URI = "https://github.com/lorenkr/spotify-turntable/blob/main/docs/callback.html"
SCOPE = "user-read-currently-playing user-read-playback-state"


class SpotifyClient:
    def __init__(self):
        client_id = os.getenv("CLIENT_ID", "")
        client_secret = os.getenv("CLIENT_SECRET", "")
        self.configured = bool(client_id and client_secret and not client_id.startswith("your_"))
        self.auth = None
        self.sp = None
        if not self.configured:
            return
        self.auth = SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=os.getenv("REDIRECT_URI", DEFAULT_REDIRECT_URI),
            scope=SCOPE,
            # Absolute path, so the login is remembered no matter where the app is launched from.
            cache_handler=CacheFileHandler(cache_path=str(APP_DIR / ".cache")),
            open_browser=False,
        )
        self.sp = spotipy.Spotify(auth_manager=self.auth, requests_timeout=8, retries=1)

    # --- Authentication -------------------------------------------------
    def is_authorized(self):
        """True when a valid (or refreshable) token is cached. Never prompts."""
        token = self.auth.cache_handler.get_cached_token()
        try:
            return self.auth.validate_token(token) is not None
        except SpotifyOauthError:
            # The saved login was revoked or expired — forget it and ask again.
            (APP_DIR / ".cache").unlink(missing_ok=True)
            return False

    def authorize_url(self):
        return self.auth.get_authorize_url()

    def complete_auth(self, redirected_url_or_code):
        code = self.auth.parse_response_code(redirected_url_or_code.strip())
        self.auth.get_access_token(code, as_dict=False, check_cache=False)

    # --- Playback -------------------------------------------------------
    def now_playing(self):
        """Returns a dict describing the current playback, or {"state": "idle"}."""
        pb = self.sp.current_playback(additional_types="track,episode")
        if not pb or not pb.get("item"):
            return {"state": "idle"}

        item = pb["item"]
        if item.get("type") == "episode":
            show = item.get("show") or {}
            artist = show.get("name", "")
            album = ""
            images = item.get("images") or show.get("images") or []
        else:
            artist = ", ".join(a["name"] for a in item.get("artists", []))
            album = (item.get("album") or {}).get("name", "")
            images = (item.get("album") or {}).get("images") or []

        return {
            "state": "ok",
            "id": item.get("id") or item.get("uri") or item.get("name"),
            "name": item.get("name", ""),
            "artist": artist,
            "album": album,
            # images[0] is the largest (640x640)
            "image_url": images[0]["url"] if images else None,
            "is_playing": bool(pb.get("is_playing")),
            "progress_ms": pb.get("progress_ms") or 0,
            "duration_ms": item.get("duration_ms") or 0,
        }
