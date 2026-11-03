"""Multi-business tenancy helpers for Brew & Scoop."""

import os
import re
import shutil
from functools import wraps

from flask import jsonify, session

ROLES = ("admin", "supervisor", "stock_manager", "seller")

DEFAULT_PRIMARY_COLOR = "#012100"
DEFAULT_ACCENT_COLOR = "#efd196"
DEFAULT_LOGO_URL = "/static/img/logo.png?v=cundino1"
LEGACY_DEFAULT_PRIMARY_COLOR = "#2c1810"
LEGACY_DEFAULT_ACCENT_COLOR = "#c4a574"
HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
LOGO_ALLOWED_EXTENSIONS = frozenset({"png", "jpg", "jpeg", "webp"})


def slugify_business_name(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "business"


def normalize_hex_color(value, default=DEFAULT_PRIMARY_COLOR):
    raw = (value or "").strip()
    if not raw:
        return default
    if not raw.startswith("#"):
        raw = f"#{raw}"
    if not HEX_COLOR_RE.match(raw):
        raise ValueError("Colors must be hex values like #012100")
    return raw.lower()


def business_uploads_dir(business_id, create=False):
    base = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "static",
        "uploads",
        "businesses",
        str(int(business_id)),
    )
    if create:
        os.makedirs(base, exist_ok=True)
    return base


def business_logo_url(logo_path):
    if not logo_path:
        return None
    path = str(logo_path).lstrip("/")
    if path.startswith("static/"):
        return f"/{path}"
    return f"/static/{path}"


def remove_business_uploads(business_id):
    folder = business_uploads_dir(business_id, create=False)
    if os.path.isdir(folder):
        shutil.rmtree(folder, ignore_errors=True)


def init_business_tables(db):
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS businesses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
            logo_path TEXT,
            primary_color TEXT NOT NULL DEFAULT '#012100',
            accent_color TEXT NOT NULL DEFAULT '#efd196',
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
    keys = row.keys()
    logo_path = row["logo_path"] if "logo_path" in keys else None
    primary = (
        row["primary_color"]
        if "primary_color" in keys and row["primary_color"]
        else DEFAULT_PRIMARY_COLOR
    )
    accent = (
        row["accent_color"]
        if "accent_color" in keys and row["accent_color"]
        else DEFAULT_ACCENT_COLOR
    )
    logo_url = business_logo_url(logo_path) or DEFAULT_LOGO_URL
    return {
        "id": row["id"],
        "name": row["name"],
        "slug": row["slug"],
        "is_active": bool(row["is_active"]),
        "logo_path": logo_path,
        "logo_url": logo_url,
        "primary_color": primary,
        "accent_color": accent,
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


def list_active_businesses(db):
    rows = db.execute(
        """SELECT id, name, slug, is_active
           FROM businesses
           WHERE is_active = 1
           ORDER BY name COLLATE NOCASE ASC"""
    ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "slug": row["slug"],
            "role": "admin",
            "is_active": True,
        }
        for row in rows
    ]


def list_switchable_businesses(db, user_id, is_platform_admin=False):
    """Businesses the user can enter from the dashboard switcher."""
    memberships = list_user_memberships(db, user_id, active_only=True)
    if not is_platform_admin:
        return memberships
    by_id = {m["id"]: m for m in memberships}
    merged = []
    for biz in list_active_businesses(db):
        existing = by_id.get(biz["id"])
        merged.append(existing or biz)
    return merged


def upsert_membership(db, user_id, business_id, role, is_active=True, created_at=None):
    if role not in ROLES:
        raise ValueError(f"Invalid role: {role}")
    # Business admins are limited to one shop. Super admins may belong to many.
    if (
        role == "admin"
        and is_active
        and not user_is_platform_admin(db, user_id)
    ):
        other = db.execute(
            """SELECT business_id FROM user_business_memberships
               WHERE user_id = ? AND role = 'admin' AND is_active = 1
                 AND business_id != ?""",
            (user_id, business_id),
        ).fetchone()
        if other:
            raise ValueError(
                "Business admins can only access one shop. "
                "Use Super Admin → Businesses → Limit access to move them."
            )
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


def user_is_platform_admin(db, user_id):
    row = db.execute(
        "SELECT is_platform_admin FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return bool(row and row["is_platform_admin"])


def list_business_admins(db):
    """Users with an admin membership, plus their shop access (for super-admin UI)."""
    rows = db.execute(
        """
        SELECT u.id, u.username, u.display_name, u.email, u.is_active,
               u.is_platform_admin,
               m.business_id, m.role AS membership_role, m.is_active AS membership_active,
               b.name AS business_name, b.slug AS business_slug, b.is_active AS business_is_active
        FROM users u
        JOIN user_business_memberships m ON m.user_id = u.id
        JOIN businesses b ON b.id = m.business_id
        WHERE m.role = 'admin'
        ORDER BY u.is_platform_admin DESC, u.display_name COLLATE NOCASE ASC, b.name COLLATE NOCASE ASC
        """
    ).fetchall()

    by_id = {}
    for row in rows:
        entry = by_id.get(row["id"])
        if entry is None:
            entry = {
                "id": row["id"],
                "username": row["username"],
                "display_name": row["display_name"],
                "email": (row["email"] or "").strip() if "email" in row.keys() else "",
                "is_active": bool(row["is_active"]),
                "is_platform_admin": bool(row["is_platform_admin"]),
                "businesses": [],
            }
            by_id[row["id"]] = entry
        entry["businesses"].append(
            {
                "id": row["business_id"],
                "name": row["business_name"],
                "slug": row["business_slug"],
                "role": row["membership_role"],
                "is_active": bool(row["membership_active"] and row["business_is_active"]),
            }
        )
    return list(by_id.values())


def set_business_admin_access(db, user_id, business_id, created_at=None):
    """Limit a non–platform admin to exactly one business (admin role).

    Removes all other memberships for that user. Platform admins cannot be limited.
    """
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        raise ValueError("User not found")
    if user["is_platform_admin"]:
        raise ValueError("Super admins already have access to all businesses")
    if not user["is_active"]:
        raise ValueError("Cannot assign an inactive account")

    business = get_business_by_id(db, business_id)
    if not business:
        raise ValueError("Business not found")
    if not business["is_active"]:
        raise ValueError("Business is inactive")

    if created_at is None:
        from datetime import datetime, timezone

        created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    db.execute(
        "DELETE FROM user_business_memberships WHERE user_id = ?",
        (user_id,),
    )
    upsert_membership(db, user_id, business_id, "admin", True, created_at)
    db.execute(
        """UPDATE users
           SET role = 'admin', updated_at = ?
           WHERE id = ?""",
        (created_at, user_id),
    )
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "is_platform_admin": False,
        "businesses": [
            {
                "id": business["id"],
                "name": business["name"],
                "slug": business["slug"],
                "role": "admin",
                "is_active": True,
            }
        ],
    }


def assign_sole_admin_membership(db, user_id, business_id, created_at=None):
    """Attach a non–platform user as sole-business admin (used when creating shops)."""
    if user_is_platform_admin(db, user_id):
        upsert_membership(db, user_id, business_id, "admin", True, created_at)
        return
    set_business_admin_access(db, user_id, business_id, created_at=created_at)


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
        """INSERT INTO businesses
           (name, slug, is_active, logo_path, primary_color, accent_color,
            created_at, updated_at)
           VALUES (?, ?, 1, NULL, ?, ?, ?, ?)""",
        (
            name,
            slug,
            DEFAULT_PRIMARY_COLOR,
            DEFAULT_ACCENT_COLOR,
            created_at,
            created_at,
        ),
    )
    return cur.lastrowid


def delete_business(db, business_id):
    """Permanently remove a business and its scoped operational data.

    Raises ValueError with a user-facing message when deletion is blocked.
    """
    business_id = int(business_id)
    row = get_business_by_id(db, business_id)
    if not row:
        raise ValueError("Business not found")

    total = db.execute("SELECT COUNT(*) AS n FROM businesses").fetchone()["n"]
    if total <= 1:
        raise ValueError("Cannot delete the only business")

    # Keep the original seeded shop as a non-deletable anchor.
    oldest = db.execute(
        "SELECT id FROM businesses ORDER BY id ASC LIMIT 1"
    ).fetchone()
    if oldest and oldest["id"] == business_id:
        raise ValueError("The primary business cannot be deleted")

    if current_business_id() == business_id:
        raise ValueError("Switch to another business before deleting this one")

    shift_ids = [
        r["id"]
        for r in db.execute(
            "SELECT id FROM seller_shifts WHERE business_id = ?", (business_id,)
        ).fetchall()
    ]
    if shift_ids:
        placeholders = ",".join("?" * len(shift_ids))
        db.execute(
            f"DELETE FROM shift_members WHERE shift_id IN ({placeholders})",
            shift_ids,
        )

    for table in (
        "seller_reconciliations",
        "seller_shifts",
        "seller_sessions",
        "lot_allocations",
        "product_lots",
        "ingredient_lots",
        "cup_lots",
        "cup_transactions",
        "transactions",
        "ingredient_transactions",
        "product_recipes",
        "ingredients",
        "products",
        "categories",
        "service_tables",
        "cup_inventory",
        "activity_logs",
        "user_business_memberships",
    ):
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        if exists:
            db.execute(f"DELETE FROM {table} WHERE business_id = ?", (business_id,))

    db.execute("DELETE FROM businesses WHERE id = ?", (business_id,))
    remove_business_uploads(business_id)
    return row_to_business(row)


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
