#!/usr/bin/env python3
"""Create/update Brew & Scoop floor staff and reset starter PINs.

For PythonAnywhere (Bash console):

  cd ~/brew-scoop-main
  python3.10 scripts/setup_floor_staff.py

What it does:
  - Creates missing seller accounts (or updates existing ones matched by name)
  - Sets PIN to 0000 for all listed workers
  - Forces each person to choose a personal PIN after first login
  - Marks Beza Cynthia, Asiimwe Angel, and Rugira Patrick as floor supervisors
    (they can close & reconcile; others only sell)
  - Leaves admin accounts untouched

Uses BREW_SCOOP_DATABASE from .env when set.
"""

import os
import re
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from env_loader import load_env_file

load_env_file(os.path.join(ROOT, ".env"))

from werkzeug.security import generate_password_hash

from reporting import connect_db, get_database_path

STARTER_PIN = "0000"

# Floor staff. can_supervise_shift=True means they can close & reconcile.
WORKERS = [
    {"display_name": "Beza Cynthia", "can_supervise_shift": True},
    {"display_name": "Asiimwe Angel", "can_supervise_shift": True},
    {"display_name": "Rutinywa Mike", "can_supervise_shift": False},
    {"display_name": "Thierry Henry Mugisha", "can_supervise_shift": False},
    {"display_name": "Rugira Patrick", "can_supervise_shift": True},
]


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def username_from_name(display_name):
    cleaned = re.sub(r"[^a-z0-9]+", ".", display_name.strip().lower())
    cleaned = cleaned.strip(".")
    return cleaned or "seller"


def ensure_columns(db):
    cols = {row[1] for row in db.execute("PRAGMA table_info(users)").fetchall()}
    if "must_change_pin" not in cols:
        db.execute(
            "ALTER TABLE users ADD COLUMN must_change_pin INTEGER NOT NULL DEFAULT 0"
        )
    if "can_supervise_shift" not in cols:
        db.execute(
            "ALTER TABLE users ADD COLUMN can_supervise_shift INTEGER NOT NULL DEFAULT 0"
        )
    if "pin" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN pin TEXT")
    # Shared starter PINs are allowed while must_change_pin=1.
    db.execute("DROP INDEX IF EXISTS idx_users_pin")
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pin_permanent ON users(pin) "
        "WHERE pin IS NOT NULL AND pin != '' AND IFNULL(must_change_pin, 0) = 0"
    )


def find_user(db, display_name):
    row = db.execute(
        """SELECT * FROM users
           WHERE display_name = ? COLLATE NOCASE
           LIMIT 1""",
        (display_name,),
    ).fetchone()
    if row:
        return row
    # Fallback: username derived from name
    uname = username_from_name(display_name)
    return db.execute(
        "SELECT * FROM users WHERE username = ? COLLATE NOCASE LIMIT 1",
        (uname,),
    ).fetchone()


def unique_username(db, display_name, exclude_id=None):
    base = username_from_name(display_name)
    candidate = base
    n = 2
    while True:
        row = db.execute(
            "SELECT id FROM users WHERE username = ? COLLATE NOCASE",
            (candidate,),
        ).fetchone()
        if row is None or (exclude_id is not None and row["id"] == exclude_id):
            return candidate
        candidate = f"{base}{n}"
        n += 1


def upsert_worker(db, worker):
    display_name = worker["display_name"].strip()
    can_supervise = 1 if worker["can_supervise_shift"] else 0
    ts = now_iso()
    existing = find_user(db, display_name)

    if existing:
        if existing["role"] == "admin":
            return "skipped_admin", existing
        db.execute(
            """UPDATE users
               SET display_name = ?,
                   role = 'seller',
                   is_active = 1,
                   pin = ?,
                   must_change_pin = 1,
                   can_supervise_shift = ?,
                   updated_at = ?
               WHERE id = ?""",
            (display_name, STARTER_PIN, can_supervise, ts, existing["id"]),
        )
        # Keep open-shift membership role in sync with floor-supervisor flag.
        role_on_shift = "supervisor" if can_supervise else "member"
        db.execute(
            """UPDATE shift_members
               SET role_on_shift = ?
               WHERE user_id = ? AND left_at IS NULL""",
            (role_on_shift, existing["id"]),
        )
        return "updated", existing

    username = unique_username(db, display_name)
    password = f"{username}@temp"
    cur = db.execute(
        """INSERT INTO users
           (username, password_hash, display_name, role, is_active,
            must_change_password, must_change_pin, can_supervise_shift, pin,
            created_at, updated_at)
           VALUES (?, ?, ?, 'seller', 1, 0, 1, ?, ?, ?, ?)""",
        (
            username,
            generate_password_hash(password),
            display_name,
            can_supervise,
            STARTER_PIN,
            ts,
            ts,
        ),
    )
    row = db.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return "created", row


def main():
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
        ensure_columns(db)
        print(f"Database: {db_path}")
        print(f"Starter PIN for all listed workers: {STARTER_PIN}")
        print("They must choose a personal PIN after first login.\n")

        for worker in WORKERS:
            action, row = upsert_worker(db, worker)
            role_label = (
                "floor supervisor"
                if worker["can_supervise_shift"]
                else "seller"
            )
            if action == "skipped_admin":
                print(f"  SKIP  {worker['display_name']} (admin — left untouched)")
                continue
            verb = "CREATED" if action == "created" else "UPDATED"
            print(
                f"  {verb:7} {row['display_name']}  "
                f"username={row['username']}  role={role_label}  pin={STARTER_PIN}"
            )

        db.commit()
        print("\nDone.")
        print("On login with 0000, pick your name if several people share it,")
        print("then set a new personal PIN on the Profile screen.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
