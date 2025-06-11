import discord
import re
import requests
import asyncio
import math
import datetime
from datetime import datetime, timedelta, timezone
from discord import ui
import logging
import os
import sys
import time
from datetime import datetime, timedelta

intents = discord.Intents.default()
intents.message_content = True
intents.members = True
client = discord.Client(intents=intents)

DM_CHANNEL_ID =

image_channel_id =
guess_channel_id =
ping_role_id =
winner_role_id =

LETS_PLAY_ROLE_ID =

original_lat = None
original_lon = None
image_url = None
challenge_active = False
last_guess_times = {}
reminder_task = None
challenge_task = None
button_task = None
end_challenge_task = None

dm_original_lat = None
dm_original_lon = None
dm_image_url = None
dm_challenge_active = False
dm_last_guess_times = {}
dm_button_task = None
dm_end_challenge_task = None

class GuessModal(ui.Modal, title="Submit your guess"):
    def __init__(self, is_dm_challenge=False):
        super().__init__()
        self.is_dm_challenge = is_dm_challenge
        self.guess = ui.TextInput(
            label="Enter your guess",
            placeholder="guess using https://chatguessr.com/map/PlonkIt",
            required=True,
            style=discord.TextStyle.short
        )
        self.add_item(self.guess)

    async def on_submit(self, interaction: discord.Interaction):
        global last_guess_times, dm_last_guess_times

        guess_match = re.fullmatch(r"/w PlonkIt !g (-?\d+\.\d+), (-?\d+\.\d+)", self.guess.value.strip())
        if not guess_match:
            await interaction.response.send_message("Invalid format! Please use the chatguessr map at https://chatguessr.com/map/PlonkIt to make a guess like this : /w PlonkIt !g latitude, longitude", ephemeral=True)
            return

        guess_lat = float(guess_match.group(1))
        guess_lon = float(guess_match.group(2))
        
        if self.is_dm_challenge:
            if dm_original_lat is None or dm_original_lon is None:
                await interaction.response.send_message("Error: DM challenge coordinates are not set properly. Please contact an admin.", ephemeral=True)
                return
            distance = haversine(dm_original_lat, dm_original_lon, guess_lat, guess_lon)
            guess_times_dict = dm_last_guess_times
            target_lat, target_lon = dm_original_lat, dm_original_lon
        else:
            if original_lat is None or original_lon is None:
                await interaction.response.send_message("Error: Challenge coordinates are not set properly. Please contact an admin.", ephemeral=True)
                return
            distance = haversine(original_lat, original_lon, guess_lat, guess_lon)
            guess_times_dict = last_guess_times
            target_lat, target_lon = original_lat, original_lon
            
        if distance is None:
            await interaction.response.send_message("An error occurred while calculating the distance. Please try again.", ephemeral=True)
            return
        formatted_distance = format_distance(distance)

        user_id = interaction.user.id
        now = datetime.now(timezone.utc)

        if user_id in guess_times_dict and (now - guess_times_dict[user_id]) < timedelta(seconds=120):
            remaining_seconds = 120 - int((now - guess_times_dict[user_id]).total_seconds())
            await interaction.response.send_message(f"Sorry {interaction.user.mention}, you can only make a guess once every 2 minutes. Please wait {remaining_seconds} seconds!", ephemeral=True)
            return
        guess_times_dict[user_id] = now
        await interaction.response.send_message("Your guess has been submitted!", ephemeral=True)
        
        guess_maps_url = f"https://www.google.com/maps/place/{guess_lat},{guess_lon}"
        
        if not self.is_dm_challenge:
            guesses_log_channel = interaction.guild.get_channel(1369360194991165580)
            guess_embed = discord.Embed(
                title=f"🎯 New Guess by {interaction.user.display_name}",
                description=f"{interaction.user.mention} guessed and was {formatted_distance} away",
                color=discord.Color.blue()
            )
            guess_embed.add_field(name="View on Google Maps", value=f"[Click here]({guess_maps_url})", inline=True)
            guess_embed.set_footer(text=f"Guess made at {now.strftime('%H:%M:%S UTC')}")
            
            if guesses_log_channel:
                await guesses_log_channel.send(embed=guess_embed)
        
        if distance <= 200:
            if self.is_dm_challenge:
                global dm_challenge_active, dm_end_challenge_task
                dm_challenge_active = False
                
                if dm_end_challenge_task and not dm_end_challenge_task.done():
                    dm_end_challenge_task.cancel()
                    dm_end_challenge_task = None
            else:
                global challenge_active, end_challenge_task
                challenge_active = False
                
                if end_challenge_task and not end_challenge_task.done():
                    end_challenge_task.cancel()
                    end_challenge_task = None
                    
            google_maps_url = f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={target_lat},{target_lon}&heading=0&pitch=0"
            embed = discord.Embed(
                title="🎉 5k Achieved!",
                description=f"{interaction.user.mention}, you were {formatted_distance} away!",
                color=discord.Color.green()
            )
            embed.add_field(name="Exact Location", value=f"[Click here to view on Streetview]({google_maps_url})")
            embed.set_footer(text="Great job!")
            
            await interaction.channel.send(embed=embed)
            
            if not self.is_dm_challenge:
                asyncio.create_task(self.handle_winner_role(interaction))
                asyncio.create_task(self.announce_winner(interaction))
                asyncio.create_task(self.restart_bot())
            else:
                asyncio.create_task(self.restart_dm_challenge())
            
        else:
            embed = discord.Embed(
                title="🚶 Keep Guessing!",
                description=f"{interaction.user.mention}, you are {format_distance(distance)} away.",
                color=discord.Color.orange()
            )
            await interaction.channel.send(embed=embed)
            
    async def handle_winner_role(self, interaction):
        try:
            winner_role = discord.utils.get(interaction.guild.roles, id=winner_role_id)
            
            members_with_role = [member for member in interaction.guild.members if winner_role in member.roles]
            
            for member in members_with_role:
                await member.remove_roles(winner_role)
            
            await interaction.user.add_roles(winner_role)
        except Exception as e:
            print(f"Error handling winner role: {e}")
    
    async def announce_winner(self, interaction):
        try:
            current_date = datetime.now().strftime("%d/%m/%Y")
            winner_channel = interaction.guild.get_channel(1305096064046600263)
            await winner_channel.send(f"5k daily challenge winner of {current_date} is {interaction.user.mention}")
        except Exception as e:
            print(f"Error announcing winner: {e}")
    
    async def restart_bot(self):
        try:
            await asyncio.sleep(15)
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            print(f"Error restarting bot: {e}")
    
    async def restart_dm_challenge(self):
        try:
            global dm_challenge_active, dm_original_lat, dm_original_lon, dm_image_url, dm_last_guess_times
            await asyncio.sleep(5)
            dm_challenge_active = False
            dm_original_lat = None
            dm_original_lon = None
            dm_image_url = None
            dm_last_guess_times.clear()
        except Exception as e:
            print(f"Error restarting DM challenge: {e}")

class GuessButton(ui.Button):
    def __init__(self, challenge_active: bool, is_dm_challenge=False):
        super().__init__(
            label="Guess Here",
            style=discord.ButtonStyle.primary,
            custom_id="guess_button" if not is_dm_challenge else "dm_guess_button",
            disabled=not challenge_active
        )
        self.challenge_active = challenge_active
        self.is_dm_challenge = is_dm_challenge

    async def callback(self, interaction: discord.Interaction):
        if not self.challenge_active:
            if self.is_dm_challenge:
                await interaction.response.send_message("There is no active dm challenge right now!", ephemeral=True)
            else:
                await interaction.response.send_message("There is no active challenge right now! Come back at 9pm eu time !", ephemeral=True)
            return
        
        try:
            await interaction.response.send_modal(GuessModal(is_dm_challenge=self.is_dm_challenge))
        except discord.errors.NotFound:
            try:
                await interaction.followup.send_modal(GuessModal(is_dm_challenge=self.is_dm_challenge))
            except Exception as e:
                print(f"Error sending modal: {e}")
                await interaction.response.send_message("Unable to open guess modal. Please try again or ping @Armagnac to ask him for help", ephemeral=True)

class GuessView(ui.View):
    def __init__(self, challenge_active: bool, is_dm_challenge=False):
        super().__init__(timeout=None)
        self.add_item(GuessButton(challenge_active, is_dm_challenge=is_dm_challenge))

async def end_challenge(message):
    global challenge_active
    challenge_active = False
    view = GuessView(challenge_active=False)
    await message.edit(view=view)

async def end_dm_challenge(message):
    global dm_challenge_active
    dm_challenge_active = False
    view = GuessView(challenge_active=False, is_dm_challenge=True)
    await message.edit(view=view)

def haversine(lat1, lon1, lat2, lon2):
    if lat1 is None or lon1 is None or lat2 is None or lon2 is None:
        print(f"Error: Invalid coordinates - lat1: {lat1}, lon1: {lon1}, lat2: {lat2}, lon2: {lon2}")
        return None
        
    R = 6371000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    distance_m = R * c
    return round(distance_m)

def format_distance(distance_m):
    distance_km = distance_m / 1000
    
    if distance_km >= 20000:
        return "20000km+"
    elif distance_km >= 15000:
        return "15000 to 20000km"
    elif distance_km >= 10000:
        return "10000 to 15000km"
    elif distance_km >= 5000:
        return "5000 to 10000km"
    elif distance_km >= 2500:
        return "2500 to 5000km"
    elif distance_km >= 1000:
        return "1000 to 2500km"
    elif distance_km >= 100:
        lower_bound = int(distance_km // 100) * 100
        upper_bound = lower_bound + 100
        return f"between {lower_bound} and {upper_bound} km"
    elif distance_km >= 10:
        lower_bound = int(distance_km // 10) * 10
        upper_bound = lower_bound + 10
        return f"between {lower_bound} and {upper_bound} km"
    elif distance_km >= 1:
        lower_bound = int(distance_km)
        upper_bound = lower_bound + 1
        return f"between {lower_bound} and {upper_bound} km"
    elif distance_m >= 100:
        lower_bound = int(distance_m // 100) * 100
        upper_bound = lower_bound + 100
        return f"between {lower_bound} and {upper_bound} meters"
    else:
        return f"{int(distance_m)} meters"

async def stop_dm_challenge():
    global dm_challenge_active, dm_original_lat, dm_original_lon, dm_image_url, dm_last_guess_times
    
    cancel_dm_tasks()
    
    dm_challenge_active = False
    dm_original_lat = None
    dm_original_lon = None
    dm_image_url = None
    dm_last_guess_times.clear()
    
    print(f'DM Challenge manually stopped at {datetime.now().strftime("%d/%m/%Y %H:%M:%S")}')

async def background_task_end_challenge(challenge_message, start_time):
    global challenge_active, button_task
    end_time = start_time + timedelta(hours=2)
    now = datetime.now(timezone.utc)
    
    if now < end_time:
        await asyncio.sleep((end_time - now).total_seconds())
    
    if challenge_active:
        google_maps_url = f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={original_lat},{original_lon}&heading=0&pitch=0"
        
        embed = discord.Embed(
            title="⏰ Challenge Ended - No Winner",
            description="The 5K challenge has ended. No one found the location within 2 hours.",
            color=discord.Color.red()
        )
        embed.add_field(name="Exact Location", value=f"[Click here to view on Streetview]({google_maps_url})")
        embed.set_footer(text="Better luck next time!")
        
        guess_channel = client.get_channel(guess_channel_id)
        await guess_channel.send(embed=embed)
        challenge_active = False
        if challenge_message:
            await end_challenge(challenge_message)
        
        if button_task and not button_task.done():
            button_task.cancel()
            
        print(f'Challenge ended automatically at {datetime.now().strftime("%d/%m/%Y %H:%M:%S")} with no winner')
        await asyncio.sleep(15)
        os.execv(sys.executable, [sys.executable] + sys.argv)

async def background_task_end_dm_challenge(challenge_message, start_time):
    global dm_challenge_active, dm_button_task
    end_time = start_time + timedelta(hours=2)
    now = datetime.now(timezone.utc)
    
    if now < end_time:
        await asyncio.sleep((end_time - now).total_seconds())
    
    if dm_challenge_active:
        google_maps_url = f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={dm_original_lat},{dm_original_lon}&heading=0&pitch=0"
        
        embed = discord.Embed(
            title="⏰ Dm Challenge Ended - No Winner",
            description="The challenge has ended. No one found the location within 2 hours.",
            color=discord.Color.red()
        )
        embed.add_field(name="Exact Location", value=f"[Click here to view on Streetview]({google_maps_url})")
        embed.set_footer(text="Better luck next time!")
        
        dm_channel = client.get_channel(DM_CHANNEL_ID)
        await dm_channel.send(embed=embed)
        dm_challenge_active = False
        if challenge_message:
            await end_dm_challenge(challenge_message)
        
        if dm_button_task and not dm_button_task.done():
            dm_button_task.cancel()
            
        print(f'DM Challenge ended automatically at {datetime.now().strftime("%d/%m/%Y %H:%M:%S")} with no winner')

async def background_task_resend_button(channel):
    global challenge_active, button_task

    try:
        while challenge_active:
            await asyncio.sleep(300)
            if not challenge_active:
                break
            await channel.send("Make a guess using the button below!", view=GuessView(challenge_active=challenge_active))
    except asyncio.CancelledError:
        print("Button task was cancelled")
        return

async def background_task_resend_dm_button(channel):
    global dm_challenge_active, dm_button_task

    try:
        while dm_challenge_active:
            await asyncio.sleep(300)
            if not dm_challenge_active:
                break
            await channel.send("Make a guess using the button below!", view=GuessView(challenge_active=dm_challenge_active, is_dm_challenge=True))
    except asyncio.CancelledError:
        print("DM Button task was cancelled")
        return

async def send_challenge_message(guess_channel):
    global image_url, challenge_active, button_task, end_challenge_task
    if image_url:
        await guess_channel.send(image_url)
    challenge_active = True
    embed = discord.Embed(
        title="New 5K Challenge!",
        description="Guess the location using [the ChatGuessr Map](https://chatguessr.com/map/PlonkIt).\n\n"
        "⚠️ **Note:** Reverse image search tools are **not allowed** to ensure fair play. Check the pinned message for more informations.\n"
        "Make a guess using the button below!",
        color=discord.Color.blue()
    )
    challenge_message = await guess_channel.send(embed=embed, view=GuessView(challenge_active=True))
    
    if button_task and not button_task.done():
        button_task.cancel()
    button_task = asyncio.create_task(background_task_resend_button(guess_channel))
    
    now = datetime.now(timezone.utc)
    end_challenge_task = asyncio.create_task(background_task_end_challenge(challenge_message, now))

async def send_dm_challenge_message(dm_channel):
    global dm_image_url, dm_challenge_active, dm_button_task, dm_end_challenge_task
    if dm_image_url:
        await dm_channel.send(dm_image_url)
    dm_challenge_active = True
    embed = discord.Embed(
        title="New Challenge!",
        description="Guess the location using [the ChatGuessr Map](https://chatguessr.com/map/PlonkIt).\n\n"
        "Make a guess using the button below!",
        color=discord.Color.purple()
    )
    challenge_message = await dm_channel.send(embed=embed, view=GuessView(challenge_active=True, is_dm_challenge=True))
    
    if dm_button_task and not dm_button_task.done():
        dm_button_task.cancel()
    dm_button_task = asyncio.create_task(background_task_resend_dm_button(dm_channel))
    
    now = datetime.now(timezone.utc)
    dm_end_challenge_task = asyncio.create_task(background_task_end_dm_challenge(challenge_message, now))
    
def cancel_all_tasks():
    global reminder_task, challenge_task, button_task, end_challenge_task
    
    if reminder_task and not reminder_task.done():
        reminder_task.cancel()
        reminder_task = None
    
    if challenge_task and not challenge_task.done():
        challenge_task.cancel()
        challenge_task = None
    
    if button_task and not button_task.done():
        button_task.cancel()
        button_task = None
        
    if end_challenge_task and not end_challenge_task.done():
        end_challenge_task.cancel()
        end_challenge_task = None

def cancel_dm_tasks():
    global dm_button_task, dm_end_challenge_task
    
    if dm_button_task and not dm_button_task.done():
        dm_button_task.cancel()
        dm_button_task = None
        
    if dm_end_challenge_task and not dm_end_challenge_task.done():
        dm_end_challenge_task.cancel()
        dm_end_challenge_task = None

async def send_ping_reminder(challenge_channel):
    role_ping = f"<@&{ping_role_id}>"
    await challenge_channel.send(f"{role_ping} Daily Challenge in 2 minutes!")

async def send_reminder_and_challenge(start_time):
    global challenge_active, reminder_task, challenge_task
    
    try:
        now = datetime.now(timezone.utc)
        challenge_channel = client.get_channel(guess_channel_id)
        reminder_time = start_time - timedelta(minutes=2)

        await asyncio.sleep((reminder_time - now).total_seconds())
        await send_ping_reminder(challenge_channel)

        await asyncio.sleep((start_time - reminder_time).total_seconds())
        await send_challenge_message(challenge_channel)
    except asyncio.CancelledError:
        print("Cancelled")
        return

@client.event
async def on_ready():
    print(f"Bot is ready as {client.user}")

everyone_mentions = {}
letsplay_role_mentions = [] 


@client.event
async def on_message(message):
    global original_lat, original_lon, image_url, challenge_active, last_guess_times
    global reminder_task, challenge_task
    global dm_original_lat, dm_original_lon, dm_image_url, dm_challenge_active, dm_last_guess_times

    if client.user in message.mentions:
        await message.channel.send("Don't ping unless urgent!")

    if message.author == client.user:
        return
    
    if message.content.strip() == "!5kstop":
        if dm_challenge_active:

            dm_channel = client.get_channel(DM_CHANNEL_ID)

            if dm_original_lat is not None and dm_original_lon is not None:
                target_lat, target_lon = dm_original_lat, dm_original_lon
                google_maps_url = f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={dm_original_lat},{dm_original_lon}&heading=0&pitch=0"

                if dm_channel:
                    embed = discord.Embed(
                        title="🛑 Challenge Stopped",
                        description="The DM challenge has been manually stopped.",
                        color=discord.Color.red()
                    )
                    embed.add_field(
                        name="📍 Exact Location", 
                        value=f"[View on Google Street View]({google_maps_url})\n**Lat:** `{target_lat}` | **Lon:** `{target_lon}`"
                    )
                    await dm_channel.send(embed=embed)
                    await stop_dm_challenge()
            else:
                await dm_channel.send("❌ Coordinates not available for this challenge.")
        else:
            await message.channel.send("❌ No active DM challenge to stop.")
        return

    
    if isinstance(message.channel, discord.DMChannel):
        match_command = re.search(r"/w\s*PlonkIt\s*!g\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", message.content)
        
        match_gmaps = re.search(r"https://www\.google\.com/maps/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)", message.content)

        if (match_command or match_gmaps) and message.attachments:
            if dm_challenge_active and dm_original_lat is not None and dm_original_lon is not None and dm_image_url:
                await message.channel.send("❌ A dm challenge is already active. Please wait for it to finish before starting a new one.")
                return

            cancel_dm_tasks()

            if match_command:
                dm_original_lat = float(match_command.group(1))
                dm_original_lon = float(match_command.group(2))
            else:
                dm_original_lat = float(match_gmaps.group(1))
                dm_original_lon = float(match_gmaps.group(2))

            dm_image_url = message.attachments[0].url
            dm_challenge_active = True
            dm_last_guess_times.clear()

            dm_channel = client.get_channel(DM_CHANNEL_ID)
            if dm_channel:
                await send_dm_challenge_message(dm_channel)
                await message.channel.send(f"✅ Challenge started in {dm_channel.mention}!")
            else:
                await message.channel.send("❌ Could not find the challenge channel.")
        
        elif "/w PlonkIt !g" in message.content or "google.com/maps/@" in message.content:
            await message.channel.send("❌ Invalid location link or missing image. Please try again with a valid link and image attachment.")

    
    role_mention = f"<@&{LETS_PLAY_ROLE_ID}>" in message.content
    if role_mention:
        current_time = time.time()
        
        letsplay_role_mentions[:] = [t for t in letsplay_role_mentions if current_time - t < 30 * 60]
        
        letsplay_role_mentions.append(current_time)
        
        if len(letsplay_role_mentions) >= 2:
            await message.channel.send("Please don't spam the Let's Play role! Wait at least **1 hour** before pinging the role again. You will be punished if you do not respect this rule")
    
    everyone_mention = '@everyone' in message.content or '@here' in message.content
    if everyone_mention:
        if not message.author.guild_permissions.mention_everyone:
            current_time = time.time()
            user_id = message.author.id
            
            if user_id in everyone_mentions:
                last_mention = everyone_mentions[user_id]
                
                if current_time - last_mention < 24 * 60 * 60:
                    try:
                        timeout_until = discord.utils.utcnow() + timedelta(days=1)
                        await message.author.timeout(timeout_until, reason="Spamming @ everyone or @ here mentions")
                    except discord.Forbidden:
                        await message.channel.send(f"I don't have permission to timeout {message.author.mention}.")
                    except Exception as e:
                        print(f"Error applying timeout: {e}")
                else:
                    everyone_mentions[user_id] = current_time
            else:
                everyone_mentions[user_id] = current_time
                await message.channel.send(f"{message.author.mention} don't ping @ everyone or @ here or I will ban you.")

    if message.content.strip() == "!change" and message.channel.id == 1273947708356431933:
        cancel_all_tasks()
        
        original_lat = None
        original_lon = None
        image_url = None
        challenge_active = False
        last_guess_times.clear()
        
        await message.channel.send("✅ The previous challenge has been cleared. You can now submit a new image.")
        return

    if message.content.strip() == "!5kcheck" and message.channel.id == image_channel_id:
        if challenge_active and original_lat is not None and original_lon is not None and image_url:
            embed = discord.Embed(
                title="📌 5K Challenge Status",
                description="There is an active 5k challenge today!",
                color=discord.Color.green()
            )
            embed.add_field(name="🌍 Coordinates", value=f"{original_lat}, {original_lon}", inline=False)
            embed.set_image(url=image_url)

            await message.channel.send(embed=embed)
        else:
            embed = discord.Embed(
                title="❌ No Active Challenge",
                description="There is no active 5k challenge at the moment.",
                color=discord.Color.red()
            )
            await message.channel.send(embed=embed)
    
    if message.channel.id == image_channel_id:
        match = re.search(r"/w\s*PlonkIt\s*!g\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", message.content)
        if match and message.attachments:
            if challenge_active and original_lat is not None and original_lon is not None and image_url:
                await message.channel.send("❌ A challenge is already active. Use !change to clear the current challenge before setting up a new one.")
                return
            cancel_all_tasks()
            
            original_lat = float(match.group(1))
            original_lon = float(match.group(2))
            image_url = message.attachments[0].url

            now = datetime.now(timezone.utc)
            start_time = now.replace(hour=17, minute=5, second=0, microsecond=0)
            if now >= start_time:
                start_time += timedelta(days=1)
            start_time_paris = start_time + timedelta(hours=2)
            formatted_start_time = start_time_paris.strftime("%d/%m/%Y %H:%M:%S")
                
            challenge_active = True
            last_guess_times.clear()
            reminder_task = asyncio.create_task(send_reminder_and_challenge(start_time))
            await message.channel.send(f"✅ Challenge is set up and will start today {formatted_start_time} (Paris time).")
        elif "/w PlonkIt !g" in message.content:
            debug_channel = client.get_channel(1273947708356431933)
            if debug_channel:
                await debug_channel.send(f"❌ Invalid chatguessr link, try again with another link (click 1 meter away it should work)\n {message.content}\n : {len(message.attachments)}")

    elif message.channel.id == guess_channel_id:
        if challenge_active and not message.author.bot:
            user_id = message.author.id
            now = datetime.now(timezone.utc)

client.run('')
