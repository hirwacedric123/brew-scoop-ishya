"""Multi-business tenancy helpers for Brew & Scoop."""

import os
import re
from functools import wraps

from flask import jsonify, session

ROLES = ("admin", "supervisor", "stock_manager", "seller")


def slugify_business_name(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "business"


def init_business_tables(db):
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS businesses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_business_memberships (
            user_id INTEGER NOT NULL,
            business_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'supervisor', 'stock_manager', 'seller')),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, business_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memberships_business
            ON user_business_memberships(business_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_memberships_user
            ON user_business_memberships(user_id, is_active);
        """
    )


def row_to_business(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "slug": row["slug"],
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_business_by_id(db, business_id):
    return db.execute(
        "SELECT * FROM businesses WHERE id = ?", (business_id,)
    ).fetchone()


def get_membership(db, user_id, business_id):
    return db.execute(
        """SELECT m.*, b.name AS business_name, b.slug AS business_slug,
                  b.is_active AS business_is_active
           FROM user_business_memberships m
           JOIN businesses b ON b.id = m.business_id
           WHERE m.user_id = ? AND m.business_id = ?""",
        (user_id, business_id),
    ).fetchone()


def list_user_memberships(db, user_id, active_only=True):
    query = """
        SELECT m.business_id, m.role, m.is_active AS membership_active,
               b.name, b.slug, b.is_active AS business_is_active
        FROM user_business_memberships m
        JOIN businesses b ON b.id = m.business_id
        WHERE m.user_id = ?
    """
    if active_only:
        query += " AND m.is_active = 1 AND b.is_active = 1"
    query += " ORDER BY b.name COLLATE NOCASE ASC"
    rows = db.execute(query, (user_id,)).fetchall()
    return [
        {
            "id": row["business_id"],
            "name": row["name"],
            "slug": row["slug"],
            "role": row["role"],
            "is_active": bool(row["membership_active"] and row["business_is_active"]),
        }
        for row in rows
    ]


def upsert_membership(db, user_id, business_id, role, is_active=True, created_at=None):
    if role not in ROLES:
        raise ValueError(f"Invalid role: {role}")
    existing = get_membership(db, user_id, business_id)
    if existing:
        db.execute(
            """UPDATE user_business_memberships
               SET role = ?, is_active = ?
               WHERE user_id = ? AND business_id = ?""",
            (role, 1 if is_active else 0, user_id, business_id),
        )
    else:
        db.execute(
            """INSERT INTO user_business_memberships
               (user_id, business_id, role, is_active, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user_id, business_id, role, 1 if is_active else 0, created_at),
        )


def current_business_id():
    try:
        value = session.get("business_id")
    except RuntimeError:
        return None
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def set_session_business(business_id):
    session["business_id"] = int(business_id)


def unique_business_slug(db, name, exclude_id=None):
    base = slugify_business_name(name)
    slug = base
    n = 2
    while True:
        row = db.execute(
            "SELECT id FROM businesses WHERE slug = ? COLLATE NOCASE", (slug,)
        ).fetchone()
        if row is None or (exclude_id is not None and row["id"] == exclude_id):
            return slug
        slug = f"{base}-{n}"
        n += 1


def create_business(db, name, created_at):
    name = (name or "").strip()
    if not name:
        raise ValueError("Business name is required")
    slug = unique_business_slug(db, name)
    cur = db.execute(
        """INSERT INTO businesses (name, slug, is_active, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)""",
        (name, slug, created_at, created_at),
    )
    return cur.lastrowid


def default_business_name():
    return os.environ.get("BREW_SCOOP_BUSINESS_NAME", "Brew & Scoop").strip() or "Brew & Scoop"


def platform_admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        from app import get_db
        from auth import (
            _block_if_password_change_required,
            _block_if_pin_change_required,
            get_current_user,
            row_to_user,
        )

        db = get_db()
        user = get_current_user(db)
        if user is None:
            return jsonify({"error": "Authentication required"}), 401
        blocked = _block_if_password_change_required(user)
        if blocked is not None:
            return blocked
        blocked = _block_if_pin_change_required(user)
        if blocked is not None:
            return blocked
        if not row_to_user(user).get("is_platform_admin"):
            return jsonify({"error": "Platform admin access required"}), 403
        return view(*args, **kwargs)

    return wrapped
