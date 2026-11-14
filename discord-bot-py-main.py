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
        check_api(f"http://127.0.0.1:{os.getenv('BOT_API_PORT', '3000')}/api/health"),
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
    reviewer_name = str(payload.get("reviewer_name", "a member of our team")).strip()[:80]

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

        safe_name = discord.utils.escape_markdown(applicant_name)
        safe_title = discord.utils.escape_markdown(position_title)
        safe_reviewer = discord.utils.escape_markdown(reviewer_name)
        safe_status = discord.utils.escape_markdown(status)
        support_url = os.getenv("LUMO_SUPPORT_URL", "").strip()

        if event == "submitted":
            color = discord.Color.from_rgb(55, 139, 255)
            status_label = "APPLICATION RECEIVED"
            intro = (
                f"Hi {safe_name},\n\n"
                f"Thanks for applying for **{safe_title}**. Your application has "
                "been safely received by our recruitment team."
            )
            next_step = (
                "Our team will review your application and contact you here "
                "when there is an update."
            )
        elif status == "Under review":
            color = discord.Color.from_rgb(245, 190, 75)
            status_label = "UNDER REVIEW"
            intro = (
                f"Hi {safe_name},\n\n"
                f"Your application for **{safe_title}** is now being reviewed "
                "by our recruitment team."
            )
            next_step = (
                "There's nothing else you need to do right now. Please keep "
                "your Discord direct messages open for updates."
            )
        elif status in {"Shortlisted", "Interview"}:
            color = discord.Color.from_rgb(145, 126, 245)
            status_label = "REVIEW COMPLETED"
            intro = (
                f"Hi {safe_name},\n\n"
                f"Our team has completed a review of your application for "
                f"**{safe_title}**. It was reviewed by **{safe_reviewer}**."
            )
            next_step = (
                "This is not a pass or fail notification. Final results will "
                "be shared with applicants once all applications have been reviewed."
            )
        elif status == "Accepted":
            color = discord.Color.from_rgb(67, 181, 129)
            status_label = "APPLICATION ACCEPTED"
            intro = (
                f"Congratulations, {safe_name}! Your application for "
                f"**{safe_title}** has been accepted."
            )
            next_step = "A member of our team will be in touch with any next steps."
        elif status == "Rejected":
            color = discord.Color.from_rgb(237, 66, 69)
            status_label = "APPLICATION UPDATE"
            intro = (
                f"Hi {safe_name},\n\nThank you for your interest in "
                f"**{safe_title}**. Unfortunately, your application has not "
                "been successful this time."
            )
            next_step = "We appreciate the time you took to apply and encourage you to keep an eye on future opportunities."
        else:
            color = discord.Color.from_rgb(145, 126, 245)
            status_label = "STATUS UPDATED"
            intro = (
                f"Hi {safe_name},\n\nThere's been an update to your "
                f"application for **{safe_title}**."
            )
            next_step = f"Your current application status is **{safe_status}**."

        embed = discord.Embed(
            title="Application Update",
            description=f"{intro}\n\n{next_step}",
            color=color,
            timestamp=datetime.now(timezone.utc)
        )
        embed.set_author(name="LUMO SHOPPING  •  CAREERS")
        embed.add_field(name="CURRENT STATUS", value=f"**{status_label}**", inline=True)
        if department:
            embed.add_field(
                name="DEPARTMENT",
                value=discord.utils.escape_markdown(department),
                inline=True
            )
        if application_id:
            embed.add_field(name="REFERENCE", value=f"`{application_id}`", inline=True)

        if support_url:
            embed.add_field(
                name="NEED HELP?",
                value=f"[Contact the Lumo team]({support_url})",
                inline=False
            )

        embed.set_footer(text="Lumo Shopping  •  Recruitment")
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
