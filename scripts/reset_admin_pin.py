#!/usr/bin/env python3
"""Reset an admin PIN in the Brew & Scoop SQLite database.

For PythonAnywhere (Bash console):

  cd ~/brew-scoop
  python3.10 scripts/reset_admin_pin.py

  # or with username:
  python3.10 scripts/reset_admin_pin.py --username admin

  # or non-interactive (e.g. automation):
  python3.10 scripts/reset_admin_pin.py --username admin --pin 1234

Uses BREW_SCOOP_DATABASE from .env when set; otherwise the project brew_scoop.db.
"""

import argparse
import getpass
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from env_loader import load_env_file

load_env_file(os.path.join(ROOT, ".env"))

from auth import pin_taken, validate_pin
from reporting import connect_db, get_database_path


def parse_args():
    parser = argparse.ArgumentParser(
        description="Reset a Brew & Scoop admin PIN (for production / PythonAnywhere).",
    )
    parser.add_argument(
        "--username",
        "-u",
        help="Admin username to reset (prompted if omitted)",
    )
    parser.add_argument(
        "--pin",
        help="New PIN (4–6 digits). Prompted securely if omitted.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List admin accounts and exit",
    )
    return parser.parse_args()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def list_admins(db):
    rows = db.execute(
        """
        SELECT id, username, display_name, email, is_active, role, pin
        FROM users
        WHERE role = 'admin'
        ORDER BY username COLLATE NOCASE
        """
    ).fetchall()
    if not rows:
        print("No admin accounts found.")
        return 1

    print(f"Database: {get_database_path()}")
    print("Admin accounts:")
    for row in rows:
        status = "active" if row["is_active"] else "inactive"
        email = (row["email"] or "").strip() or "-"
        has_pin = "yes" if (row["pin"] or "").strip() else "no"
        print(
            f"  id={row['id']}  username={row['username']}  "
            f"name={row['display_name']}  email={email}  "
            f"pin_set={has_pin}  ({status})"
        )
    return 0


def read_new_pin(cli_pin):
    if cli_pin is not None:
        error, pin = validate_pin(cli_pin)
        if error:
            print(error, file=sys.stderr)
            return None
        return pin

    pin_raw = getpass.getpass("New PIN (4–6 digits): ")
    confirm = getpass.getpass("Confirm PIN: ")
    if pin_raw != confirm:
        print("PINs do not match.", file=sys.stderr)
        return None

    error, pin = validate_pin(pin_raw)
    if error:
        print(error, file=sys.stderr)
        return None
    return pin


def main():
    args = parse_args()
    db_path = get_database_path()

    if not os.path.isfile(db_path):
        print(f"Database not found: {db_path}", file=sys.stderr)
        print(
            "Set BREW_SCOOP_DATABASE in .env to the production SQLite path, then retry.",
            file=sys.stderr,
        )
        return 1

    db = connect_db()
    try:
        if args.list:
            return list_admins(db)

        print(f"Database: {db_path}")
        list_admins(db)
        print()

        username = (args.username or input("Admin username: ")).strip()
        if not username:
            print("Username is required.", file=sys.stderr)
            return 1

        row = db.execute(
            """
            SELECT id, username, role, is_active
            FROM users
            WHERE username = ? COLLATE NOCASE AND role = 'admin'
            """,
            (username,),
        ).fetchone()
        if not row:
            print(f"No admin user found with username '{username}'.", file=sys.stderr)
            return 1

        pin = read_new_pin(args.pin)
        if not pin:
            return 1

        if pin_taken(db, pin, exclude_user_id=row["id"]):
            print("That PIN is already used by another account.", file=sys.stderr)
            return 1

        db.execute(
            """
            UPDATE users
            SET pin = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (pin, now_iso(), row["id"]),
        )
        db.commit()
        print(f"PIN updated for admin '{row['username']}' (id={row['id']}).")
        print("You can sign in with the new PIN. No web app reload is required.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
