import os
import asyncio
import time
import math
import hmac

import aiohttp
import uvicorn
import discord
import roblox

from datetime import datetime, timezone
from discord.ext import commands
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

load_dotenv()

intents = discord.Intents.default()

discord_bot = commands.Bot(
    command_prefix=".",
    intents=intents
)

app = FastAPI()

started_at = time.monotonic()


def get_latency():
    latency = discord_bot.latency * 1000

    if not math.isfinite(latency):
        return None

    return round(latency)


def get_uptime():
    seconds = int(time.monotonic() - started_at)

    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)

    return f"{days}d {hours}h {minutes}m {seconds}s"


async def check_api(url):
    start = time.perf_counter()

    try:
        timeout = aiohttp.ClientTimeout(total=3)

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                elapsed = round(
                    (time.perf_counter() - start) * 1000
                )

                if response.status == 200:
                    return f"🟢 Operational ({elapsed} ms)"

                return f"🔴 HTTP {response.status} ({elapsed} ms)"

    except (aiohttp.ClientError, asyncio.TimeoutError):
        return "🔴 Unavailable"


@discord_bot.event
async def on_ready():
    print(f"Logged in as {discord_bot.user}")
    print("Discord bot connected.")


@discord_bot.tree.command(
    name="ping",
    description="View the bot's connection information."
)
async def ping(interaction: discord.Interaction):
    await interaction.response.defer()

    latency = get_latency()

    discord_status = (
        "🟢 Connected"
        if discord_bot.is_ready()
        else "🔴 Disconnected"
    )

    api_status, roblox_status = await asyncio.gather(
        check_api("http://127.0.0.1:3000/api/health"),
        check_api("https://users.roblox.com/v1/users/1")
    )

    shard_id = (
        interaction.guild.shard_id
        if interaction.guild
        else 0
    )

    shard_count = discord_bot.shard_count or 1

    response_ms = round(
        (
            datetime.now(timezone.utc)
            - interaction.created_at
        ).total_seconds() * 1000
    )

    embed = discord.Embed(
        title="🏓 Connection Information",
        description="Current status of the Lumo Ranking bot.",
        color=discord.Color.from_rgb(43, 45, 49)
    )

    embed.add_field(
        name="Discord Connection",
        value=discord_status,
        inline=False
    )

    embed.add_field(
        name="WebSocket Latency",
        value=(
            f"{latency} ms"
            if latency is not None
            else "Unavailable"
        ),
        inline=False
    )

    embed.add_field(
        name="API Status",
        value=api_status,
        inline=False
    )

    embed.add_field(
        name="Roblox API",
        value=roblox_status,
        inline=False
    )

    embed.add_field(
        name="Uptime",
        value=get_uptime(),
        inline=False
    )

    embed.add_field(
        name="Shard",
        value=f"{shard_id} / {shard_count}",
        inline=False
    )

    embed.add_field(
        name="Response Time",
        value=f"{response_ms} ms",
        inline=False
    )

    embed.set_footer(
        text="Lumo Shopping • Ranking System V2"
    )

    await interaction.followup.send(embed=embed)


@app.post("/api/notifications/application")
async def application_notification(payload: dict, x_lumo_notification_secret: str = Header(default="")):
    expected_secret = os.getenv("BOT_NOTIFICATION_SECRET", "").strip()
    if not expected_secret or not hmac.compare_digest(
        x_lumo_notification_secret,
        expected_secret
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")

    discord_id = str(payload.get("discord_id", "")).strip()
    event = str(payload.get("event", "")).strip().lower()
    application_id = str(payload.get("application_id", "")).strip()
    applicant_name = str(payload.get("applicant_name", "there")).strip()[:80]
    position_title = str(payload.get("position_title", "your application")).strip()[:120]
    department = str(payload.get("department", "")).strip()[:80]
    status = str(payload.get("status", "")).strip()[:40]
    previous_status = str(payload.get("previous_status", "")).strip()[:40]

    if not discord_id.isdigit() or event not in {"submitted", "status"}:
        raise HTTPException(status_code=400, detail="Invalid notification payload")

    if not discord_bot.is_ready():
        raise HTTPException(status_code=503, detail="Discord bot is not ready")

    if event == "status" and not status:
        raise HTTPException(status_code=400, detail="Missing application status")

    try:
        recipient = discord_bot.get_user(int(discord_id))
        if recipient is None:
            recipient = await discord_bot.fetch_user(int(discord_id))

        if event == "submitted":
            embed = discord.Embed(
                title="<:idcard:1539719123846823946> Application Received",
                description=(
                    f"Hi **{discord.utils.escape_markdown(applicant_name)}**! "
                    f"We've successfully received your application for "
                    f"**{discord.utils.escape_markdown(position_title)}**."
                    "\n\nOur team will review it and contact you when there is an update."
                ),
                color=discord.Color.from_rgb(43, 45, 49)
            )
            embed.add_field(name="Application", value=position_title or "Not specified", inline=False)
            embed.add_field(name="Status", value="<:toggleoff:1539719276955435098> Pending", inline=True)
        else:
            status_emojis = {
                "Pending": "<:idcard:1539719123846823946>",
                "Under review": "<:toggleon:1539719294546481354>",
                "Shortlisted": "<:toggleon:1539719294546481354>",
                "Interview": "<:toggleon:1539719294546481354>",
                "Accepted": "<:toggleon:1539719294546481354>",
                "Rejected": "<:warning~1:1517225000262701117>"
            }
            embed = discord.Embed(
                title="<:toggleon:1539719294546481354> Application Update",
                description=(
                    f"Hi **{discord.utils.escape_markdown(applicant_name)}**, "
                    f"there's been an update to your application for "
                    f"**{discord.utils.escape_markdown(position_title)}**."
                ),
                color=discord.Color.from_rgb(43, 45, 49)
            )
            if previous_status:
                embed.add_field(name="Previous Status", value=previous_status, inline=True)
            embed.add_field(
                name="New Status",
                value=f"{status_emojis.get(status, '<:idcard:1539719123846823946>')} {status}",
                inline=True
            )
            if status == "Accepted":
                embed.add_field(
                    name="Next Steps",
                    value="Congratulations! The Lumo team will be in touch with further information.",
                    inline=False
                )
            elif status == "Rejected":
                embed.add_field(
                    name="Update",
                    value="Thank you for taking the time to apply to Lumo Shopping. We appreciate your interest.",
                    inline=False
                )

        if department:
            embed.add_field(name="Department", value=department, inline=False)
        if application_id:
            embed.add_field(name="Application Reference", value=f"`{application_id}`", inline=False)

        embed.set_footer(text="Lumo Shopping • Applications")
        await recipient.send(embed=embed)
        return {"ok": True, "sent": True}

    except discord.Forbidden:
        return {"ok": True, "sent": False, "reason": "User DMs are disabled or bot is blocked"}
    except discord.HTTPException as error:
        print(f"Applicant DM failed for {discord_id}: {error}")
        raise HTTPException(status_code=502, detail="Discord could not deliver the DM")


@app.get("/api/health")
async def health():
    latency = get_latency()

    if discord_bot.is_ready():
        return {
            "status": "online",
            "latency": latency,
            "latency_unit": "ms",
            "uptime": get_uptime()
        }

    return JSONResponse(
        status_code=503,
        content={
            "status": "offline",
            "latency": None,
            "latency_unit": "ms",
            "uptime": get_uptime()
        }
    )


async def main():
    token = os.getenv("DISCORD_TOKEN")

    if not token:
        raise ValueError(
            "DISCORD_TOKEN is missing from .env"
        )

    await roblox.start()

    await discord_bot.load_extension("commands.profile")
    await discord_bot.load_extension("commands.set-rank")

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=os.getenv("BOT_API_HOST", "0.0.0.0"),
            port=int(os.getenv("BOT_API_PORT", "3000"))
        )
    )

    try:
        async with discord_bot:
            await discord_bot.login(token)

            await discord_bot.tree.sync()

            print("Slash commands synced.")
            print("Roblox API client started.")
            print(f"Bot API listening on {os.getenv('BOT_API_HOST', '0.0.0.0')}:{os.getenv('BOT_API_PORT', '3000')}")

            await asyncio.gather(
                discord_bot.connect(),
                server.serve()
            )

    finally:
        await roblox.close()


asyncio.run(main())
