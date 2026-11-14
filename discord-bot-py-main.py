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
            print("Health API running on 127.0.0.1:3000")

            await asyncio.gather(
                discord_bot.connect(),
                server.serve()
            )

    finally:
        await roblox.close()


asyncio.run(main())
