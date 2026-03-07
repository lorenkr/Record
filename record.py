import tkinter as tk
from io import BytesIO
import requests
from PIL import Image, ImageTk, ImageFilter, ImageDraw
import spotifyPlay

# --- Constants & Config ---
WINDOW_WIDTH = 665
WINDOW_HEIGHT = 225
REFRESH_RATE_MS = 2000  # Check Spotify every 2 seconds
ANIMATION_SPEED_MS = 20 # Rotate every 20ms

# Initialize main window
root = tk.Tk()
root.title("Spotify Vinyl Player")
root.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}")

# --- Global State ---
# We need to keep references to images so Tkinter's garbage collector doesn't delete them
current_image_url = ""
bg_photo = None
vinyl_photo_rotated = None
sticker_photo_rotated = None
needle_photo = None

# Source images (kept in memory for rotation/manipulation)
vinyl_source = None
sticker_source = None

# Canvas setup
canvas = tk.Canvas(root, width=WINDOW_WIDTH, height=WINDOW_HEIGHT, highlightthickness=0)
canvas.pack(fill="both", expand=True)

# Define center points
CENTER_X = WINDOW_WIDTH // 2
CENTER_Y = WINDOW_HEIGHT // 2

# Create canvas objects (placeholders)
bg_id = canvas.create_image(0, 0, anchor="nw")
record_id = canvas.create_image(CENTER_X, CENTER_Y, anchor="center")
sticker_id = canvas.create_image(CENTER_X, CENTER_Y, anchor="center")
# Needle position
needle_id = canvas.create_image(380, 70, anchor="w")

# Text objects for song info
song_id = canvas.create_text(15, 80, text="Waiting for music...", width=250, fill="white", font=("Arial", 20, "bold"), anchor='w')
singer_id = canvas.create_text(15, 120, text="", width=200, fill="white", font=("Arial", 16), anchor='w')


def load_static_assets():
    """Loads the vinyl record and needle images once at startup."""
    global vinyl_source, needle_photo
    
    # Load and prep the Vinyl Record image
    try:
        vinyl_source = Image.open("img/vinyl.png").convert("RGBA")
        vinyl_source = vinyl_source.filter(ImageFilter.GaussianBlur(radius=0.8))
        vinyl_source = vinyl_source.resize((180, 180), Image.LANCZOS)
        
        # Load and prep the Needle/Arm image
        # Note: Depending on your file, you might need 'needle.png' or 'record_arm.png'
        needle_img = Image.open("img/record_arm.png").convert("RGBA")
        needle_img = needle_img.filter(ImageFilter.GaussianBlur(radius=0.8))
        needle_img = needle_img.resize((80, 130), Image.LANCZOS)
        needle_img = needle_img.rotate(-20, expand=True)
        
        needle_photo = ImageTk.PhotoImage(needle_img)
        canvas.itemconfig(needle_id, image=needle_photo)
        
    except FileNotFoundError as e:
        print(f"Error loading assets: {e}")
        print("Make sure the 'img' folder exists with vinyl.png and record_arm.png")


def update_song_display(track_info):
    """
    Downloads the album art, processes it (blur background + round sticker),
    and updates the UI.
    """
    global bg_photo, sticker_source, current_image_url
    
    image_url = track_info["image_url"]
    
    # Don't re-download if it's the same song
    if image_url == current_image_url:
        return

    print(f"Now Playing: {track_info['name']} by {track_info['artist']}")

    try:
        response = requests.get(image_url)
        img_raw = Image.open(BytesIO(response.content)).convert("RGBA")
        
        # 1. Create Blurred Background
        # We crop and resize to fill the window nicely
        img_size = WINDOW_WIDTH
        bg_img = img_raw.resize((img_size, img_size))
        
        # Center crop calculation
        x0 = (img_size - WINDOW_WIDTH) // 2
        y0 = (img_size - WINDOW_HEIGHT) // 2
        
        bg_img = bg_img.filter(ImageFilter.GaussianBlur(radius=20))
        bg_img = bg_img.crop((x0, y0, x0 + WINDOW_WIDTH, y0 + WINDOW_HEIGHT))
        
        # Update background on canvas
        bg_photo = ImageTk.PhotoImage(bg_img)
        canvas.itemconfig(bg_id, image=bg_photo)
        
        # 2. Create the Circular Sticker for the Record
        sticker_size = 80
        img_sticker = img_raw.resize((sticker_size, sticker_size), Image.LANCZOS)
        
        # Create a circular mask
        mask = Image.new("L", (sticker_size, sticker_size), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((0, 0, sticker_size, sticker_size), fill=255)
        
        img_sticker.putalpha(mask)
        
        # Save this source image for the rotation animation loop
        sticker_source = img_sticker 
        current_image_url = image_url

    except Exception as e:
        print(f"Failed to update display: {e}")


def check_spotify_updates():
    """
    Periodically polls Spotify for the current track.
    """
    global song_id, singer_id
    
    track_info = spotifyPlay.get_current_track_info()
    
    if track_info:
        # Update the visuals (Album art / Background)
        update_song_display(track_info)
        
        # Update text labels
        # We use canvas.itemconfigure to update existing text objects
        canvas.itemconfigure(song_id, text=track_info["name"])
        canvas.itemconfigure(singer_id, text=track_info["artist"])
    
    # Schedule the next check
    root.after(REFRESH_RATE_MS, check_spotify_updates)


# --- Animation Loop ---
current_angle = 0

def spin_record():
    """
    Rotates the vinyl and the sticker slightly every frame.
    """
    global current_angle, vinyl_photo_rotated, sticker_photo_rotated
    
    if vinyl_source and sticker_source:
        current_angle -= 1 # Spin counter-clockwise
        if current_angle <= -360:
            current_angle = 0
            
        # Rotate Vinyl
        rotated_vinyl = vinyl_source.rotate(current_angle)
        vinyl_photo_rotated = ImageTk.PhotoImage(rotated_vinyl)
        canvas.itemconfig(record_id, image=vinyl_photo_rotated)
        
        # Rotate Sticker
        rotated_sticker = sticker_source.rotate(current_angle)
        sticker_photo_rotated = ImageTk.PhotoImage(rotated_sticker)
        canvas.itemconfig(sticker_id, image=sticker_photo_rotated)
    
    root.after(ANIMATION_SPEED_MS, spin_record)


# --- Main Execution ---
if __name__ == "__main__":
    load_static_assets()      # Load local images
    check_spotify_updates()   # Start polling Spotify
    spin_record()             # Start animation
    
    root.mainloop()