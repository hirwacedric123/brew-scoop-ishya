#!/usr/bin/env python3
"""Reset an admin password in the Brew & Scoop SQLite database.

For PythonAnywhere (Bash console):

  cd ~/brew-scoop
  python3.10 scripts/reset_admin_password.py

  # or with username:
  python3.10 scripts/reset_admin_password.py --username admin

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

from werkzeug.security import generate_password_hash

from reporting import connect_db, get_database_path

MIN_PASSWORD_LENGTH = 6


def parse_args():
    parser = argparse.ArgumentParser(
        description="Reset a Brew & Scoop admin password (for production / PythonAnywhere).",
    )
    parser.add_argument(
        "--username",
        "-u",
        help="Admin username to reset (prompted if omitted)",
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
        SELECT id, username, display_name, email, is_active, role
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
        print(
            f"  id={row['id']}  username={row['username']}  "
            f"name={row['display_name']}  email={email}  ({status})"
        )
    return 0


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

        password = getpass.getpass("New password: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("Passwords do not match.", file=sys.stderr)
            return 1
        if len(password) < MIN_PASSWORD_LENGTH:
            print(
                f"Password must be at least {MIN_PASSWORD_LENGTH} characters.",
                file=sys.stderr,
            )
            return 1

        db.execute(
            """
            UPDATE users
            SET password_hash = ?,
                must_change_password = 0,
                updated_at = ?
            WHERE id = ?
            """,
            (generate_password_hash(password), now_iso(), row["id"]),
        )
        db.commit()
        print(f"Password updated for admin '{row['username']}' (id={row['id']}).")
        print("You can log in with the new password. No web app reload is required.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
