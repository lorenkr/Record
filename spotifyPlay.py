import os
from dotenv import load_dotenv
from spotipy import Spotify
from spotipy.oauth2 import SpotifyOAuth

# Load environment variables from .env file
load_dotenv()

# Setup Spotify authentication
# Make sure to add your CLIENT_ID and CLIENT_SECRET to the .env file!
sp = Spotify(auth_manager=SpotifyOAuth(
    client_id=os.getenv("CLIENT_ID"),
    client_secret=os.getenv("CLIENT_SECRET"),
    # This redirect URI must match exactly what you set in the Spotify Developer Dashboard
    redirect_uri="https://github.com/lorenkr/spotify-turntable/blob/main/docs/callback.html",
    scope="user-read-currently-playing user-read-playback-state"
))

def get_current_track_info():
    """
    Fetches the currently playing track from Spotify.
    Returns a dictionary with track details or None if nothing is playing.
    """
    try:
        current = sp.current_user_playing_track()
        
        # Check if a track is actually playing and has item details
        if current and current.get("item"):
            track_item = current["item"]
            
            track_name = track_item["name"]
            # Handling multiple artists - taking the first one
            artist_name = track_item["artists"][0]["name"]
            album_name = track_item["album"]["name"]
            # Get the album art URL (usually images[0] is the largest)
            album_image_url = track_item["album"]["images"][0]["url"]
            
            return {
                "name": track_name,
                "artist": artist_name,
                "album": album_name,
                "image_url": album_image_url
            }
        else:
            return None
    except Exception as e:
        print(f"Error fetching Spotify data: {e}")
        return None