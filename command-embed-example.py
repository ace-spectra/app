import os
import asyncio
import aiohttp
import discord
from datetime import datetime, timezone
from dotenv import load_dotenv
import roblox

load_dotenv()

STAFF_ROLE_ID = int(os.getenv("STAFF_ROLE_ID", "0"))
LOG_WEBHOOK_URL = os.getenv("LOG_WEBHOOK_URL", "")
EMBED_COLOR = discord.Color.from_rgb(43, 45, 49)

LOG_TITLES = {
    "OPENED": "<:idcard:1539719123846823946> Panel Opened",
    "SUCCESS": "<:toggleon:1539719294546481354> Rank Updated",
    "FAILED": "<:development:1517225139115135030> Rank Update Failed",
    "DENIED": "<:warning~1:1517225000262701117> Permission Denied"
}

def is_staff(user):
    if STAFF_ROLE_ID == 0:
        return False

    roles = getattr(user, "roles", [])

    return any(role.id == STAFF_ROLE_ID for role in roles)

def error_embed(title, text):
    return discord.Embed(
        title=title,
        description=text,
        color=EMBED_COLOR
    )

async def log_action(
    status,
    staff,
    target=None,
    headshot=None,
    previous=None,
    new=None,
    details=None
):
    now = datetime.now(timezone.utc)

    target_name = "None" if target is None else target["name"]

    print(
        f"[{now.strftime('%Y-%m-%d %H:%M:%S')}] {status} | "
        f"{staff} ({staff.id}) | {target_name} | "
        f"{previous} -> {new} | {details}"
    )

    if not LOG_WEBHOOK_URL:
        return

    lines = [f"> **Staff:** {staff.mention} (`{staff.id}`)"]

    if target is not None:
        lines.append(
            f"> **Target:** [{target['name']}]"
            f"(https://www.roblox.com/users/{target['id']}/profile) "
            f"(`{target['id']}`)"
        )

    embed = discord.Embed(
        title=LOG_TITLES.get(status, status),
        description="\n".join(lines),
        color=EMBED_COLOR,
        timestamp=now
    )

    if previous is not None:
        embed.add_field(
            name="Previous Rank",
            value=previous,
            inline=False
        )

    if new is not None:
        embed.add_field(
            name="New Rank",
            value=new,
            inline=False
        )

    if details:
        embed.add_field(
            name="Details",
            value=f"```{str(details)[:900]}```",
            inline=False
        )

    if headshot:
        embed.set_thumbnail(url=headshot)

    embed.set_footer(text="Lumo Services")

    try:
        async with aiohttp.ClientSession() as session:
            webhook = discord.Webhook.from_url(
                LOG_WEBHOOK_URL,
                session=session
            )

            await webhook.send(
                embed=embed,
                username="Lumo Rank Logs"
            )

    except (discord.HTTPException, aiohttp.ClientError, ValueError) as error:
        print(f"Webhook log failed: {error}")

class SetRankView(discord.ui.View):
    def __init__(self, owner, user, current_role, roles, headshot):
        super().__init__(timeout=120)

        self.owner = owner
        self.user = user
        self.current_role = current_role
        self.roles = roles
        self.headshot = headshot
        self.new_role = None
        self.message = None

        self.select = discord.ui.Select(
            placeholder="Select a new role...",
            options=self.make_options()
        )
        self.select.callback = self.on_select
        self.add_item(self.select)

        self.confirm = discord.ui.Button(
            label="Confirm & Update Role",
            style=discord.ButtonStyle.success,
            disabled=True
        )
        self.confirm.callback = self.on_confirm
        self.add_item(self.confirm)

        self.add_item(
            discord.ui.Button(
                label="Roblox Profile",
                url=f"https://www.roblox.com/users/{user['id']}/profile"
            )
        )

    def make_options(self):
        options = []

        for role in self.roles:
            is_selected = (
                self.new_role is not None
                and role["id"] == self.new_role["id"]
            )

            options.append(
                discord.SelectOption(
                    label=role["name"][:100],
                    value=str(role["id"]),
                    description=f"Rank {role['rank']}",
                    default=is_selected
                )
            )

        return options

    def make_embed(self):
        if self.new_role is None:
            new_role_text = "Not Selected."
        else:
            new_role_text = self.new_role["name"]

        embed = discord.Embed(
            title="Role Adjustment Panel",
            description=(
                f"Hey there, {self.owner.mention}! You are currently "
                f"managing **{self.user['name']}**. Use the menu below "
                f"to set their new role. Once you've selected a role, "
                f"click the confirm button.\n\n"
                f"> **Current Role:** {self.current_role['name']}\n"
                f"> **New Role:** {new_role_text}\n\n"
                f"*You must select a role before you can continue "
                f"managing this user's role.*"
            ),
            color=EMBED_COLOR
        )

        if self.headshot:
            embed.set_thumbnail(url=self.headshot)

        embed.set_footer(text="Lumo Services")

        return embed

    async def interaction_check(self, interaction):
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message(
                "This panel isn't yours. Run /set-rank yourself.",
                ephemeral=True
            )
            return False

        if not is_staff(interaction.user):
            await log_action(
                "DENIED",
                interaction.user,
                self.user,
                self.headshot,
                details="Lost the staff role while using a panel"
            )

            await interaction.response.send_message(
                "You no longer have permission to do this.",
                ephemeral=True
            )
            return False

        return True

    async def on_select(self, interaction):
        role_id = int(self.select.values[0])

        self.new_role = next(
            role for role in self.roles
            if role["id"] == role_id
        )

        self.select.options = self.make_options()
        self.confirm.disabled = False

        await interaction.response.edit_message(
            embed=self.make_embed(),
            view=self
        )

    async def on_confirm(self, interaction):
        if self.new_role["id"] == self.current_role["id"]:
            await interaction.response.send_message(
                "They already have that role.",
                ephemeral=True
            )
            return

        await interaction.response.defer()

        previous_text = (
            f"{self.current_role['name']} "
            f"({self.current_role['rank']})"
        )

        new_text = (
            f"{self.new_role['name']} "
            f"({self.new_role['rank']})"
        )

        try:
            await roblox.set_rank(
                self.user["id"],
                self.new_role["id"]
            )

        except Exception as error:
            print(f"/set-rank error: {error}")

            await log_action(
                "FAILED",
                interaction.user,
                self.user,
                self.headshot,
                previous_text,
                new_text,
                str(error)
            )

            await interaction.followup.send(
                embed=error_embed(
                    "<:development:1517225139115135030> Development Error",
                    "Something went wrong while updating this user's "
                    "role. The bot may not be able to set that rank."
                ),
                ephemeral=True
            )
            return

        embed = discord.Embed(
            title="<:toggleon:1539719294546481354> Rank Updated",
            description=(
                f"**{self.user['name']}**'s rank was "
                f"updated successfully."
            ),
            color=EMBED_COLOR
        )

        embed.add_field(
            name="User ID",
            value=str(self.user["id"]),
            inline=False
        )

        embed.add_field(
            name="Previous Rank",
            value=previous_text,
            inline=False
        )

        embed.add_field(
            name="New Rank",
            value=new_text,
            inline=False
        )

        if self.headshot:
            embed.set_thumbnail(url=self.headshot)

        embed.set_footer(text="Lumo Services")

        await log_action(
            "SUCCESS",
            interaction.user,
            self.user,
            self.headshot,
            previous_text,
            new_text
        )

        self.stop()

        await interaction.edit_original_response(
            embed=embed,
            view=None
        )

    async def on_timeout(self):
        for item in self.children:
            item.disabled = True

        if self.message is not None:
            try:
                await self.message.edit(view=self)
            except discord.HTTPException:
                pass

@discord.app_commands.describe(
    user_id="The Roblox user ID of the person you want to rank."
)
async def set_rank(
    interaction: discord.Interaction,
    user_id: str
):
    if not is_staff(interaction.user):
        await log_action(
            "DENIED",
            interaction.user,
            details=f"Used /set-rank without the staff role (input: {user_id})"
        )

        await interaction.response.send_message(
            embed=error_embed(
                "<:warning~1:1517225000262701117> No Permission",
                "Only staff can use this command."
            ),
            ephemeral=True
        )
        return

    await interaction.response.defer()

    user_id = user_id.strip()

    if not user_id.isdigit():
        await interaction.followup.send(
            embed=error_embed(
                "<:warning~1:1517225000262701117> Invalid ID",
                "Please paste a Roblox user ID (numbers only)."
            )
        )
        return

    try:
        user = await roblox.get_user_by_id(user_id)

        if user is None:
            await interaction.followup.send(
                embed=error_embed(
                    "<:warning~1:1517225000262701117> Unknown User",
                    "No Roblox user was found with that ID."
                )
            )
            return

        current_role, roles, headshot = await asyncio.gather(
            roblox.get_group_rank(user["id"]),
            roblox.get_roles(),
            roblox.get_headshot(user["id"])
        )

    except Exception as error:
        print(f"/set-rank error: {error}")

        await interaction.followup.send(
            embed=error_embed(
                "<:development:1517225139115135030> Development Error",
                "Something went wrong while retrieving "
                "this user's Roblox information."
            )
        )
        return

    if current_role is None:
        await interaction.followup.send(
            embed=error_embed(
                "<:warning~1:1517225000262701117> Not a Member",
                f"**{user['name']}** is not in the group, "
                f"so their rank can't be changed."
            )
        )
        return

    roles = sorted(
        (
            role for role in roles
            if 0 < role["rank"] < 255
        ),
        key=lambda role: role["rank"]
    )[:25]

    await log_action(
        "OPENED",
        interaction.user,
        user,
        headshot,
        details=(
            f"Current rank: {current_role['name']} "
            f"({current_role['rank']})"
        )
    )

    view = SetRankView(
        interaction.user,
        user,
        current_role,
        roles,
        headshot
    )

    view.message = await interaction.followup.send(
        embed=view.make_embed(),
        view=view
    )

async def setup(discord_bot):
    command = discord.app_commands.Command(
        name="set-rank",
        description="Set the rank of a Roblox user.",
        callback=set_rank
    )
    discord_bot.tree.add_command(command)
