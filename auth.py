"""Authentication helpers for Brew & Scoop."""

import re
from functools import wraps

from flask import jsonify, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

ROLES = ("admin", "supervisor", "stock_manager", "seller")


def init_users_table(db):
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            email TEXT,
            role TEXT NOT NULL CHECK(role IN ('admin', 'supervisor', 'stock_manager', 'seller')),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
            must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1)),
            pin TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        """
    )


def row_to_user(row):
    keys = row.keys()
    pin_value = (row["pin"] or "").strip() if "pin" in keys else ""
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "email": (row["email"] or "").strip() if "email" in keys else "",
        "role": row["role"],
        "is_active": bool(row["is_active"]),
        "must_change_password": bool(row["must_change_password"])
        if "must_change_password" in keys
        else False,
        "must_change_pin": bool(row["must_change_pin"])
        if "must_change_pin" in keys
        else False,
        "can_supervise_shift": bool(row["can_supervise_shift"])
        if "can_supervise_shift" in keys
        else False,
        "has_pin": bool(pin_value),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def public_user(row):
    data = row_to_user(row)
    data.pop("created_at", None)
    data.pop("updated_at", None)
    return data


def get_user_by_id(db, user_id):
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def get_user_by_username(db, username):
    return db.execute(
        "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
        (username.strip(),),
    ).fetchone()


def get_user_by_pin(db, pin):
    rows = get_users_by_pin(db, pin)
    return rows[0] if len(rows) == 1 else None


def get_users_by_pin(db, pin):
    pin = (pin or "").strip()
    if not pin:
        return []
    return db.execute(
        """SELECT * FROM users
           WHERE pin = ? AND is_active = 1
           ORDER BY display_name COLLATE NOCASE ASC""",
        (pin,),
    ).fetchall()


PIN_MIN_LEN = 4
PIN_MAX_LEN = 6


def normalize_pin(value):
    return re.sub(r"\D", "", str(value or ""))


def validate_pin(value, *, required=True):
    pin = normalize_pin(value)
    if not pin:
        return ("PIN is required" if required else None), None
    if len(pin) < PIN_MIN_LEN or len(pin) > PIN_MAX_LEN:
        return f"PIN must be {PIN_MIN_LEN}–{PIN_MAX_LEN} digits", None
    return None, pin


def pin_taken(db, pin, exclude_user_id=None):
    """Permanent PINs must be unique. Temporary shared starter PINs are allowed."""
    query = """SELECT id FROM users
               WHERE pin = ?
                 AND IFNULL(must_change_pin, 0) = 0"""
    params = [pin]
    if exclude_user_id is not None:
        query += " AND id != ?"
        params.append(exclude_user_id)
    return db.execute(query, params).fetchone() is not None


def get_current_user(db):
    user_id = session.get("user_id")
    if not user_id:
        return None
    row = get_user_by_id(db, user_id)
    if not row or not row["is_active"]:
        session.clear()
        return None
    return row


def login_user(user_id):
    session.clear()
    session["user_id"] = user_id
    session.permanent = True


def logout_user():
    session.clear()


def hash_password(password):
    return generate_password_hash(password)


def verify_password(password_hash, password):
    return check_password_hash(password_hash, password)


def verify_admin_password(db, password):
    if not password:
        return False
    rows = db.execute(
        "SELECT password_hash FROM users WHERE role = 'admin' AND is_active = 1"
    ).fetchall()
    return any(verify_password(row["password_hash"], password) for row in rows)


def validate_user_payload(data, creating=False):
    username = (data.get("username") or "").strip()
    display_name = (data.get("display_name") or "").strip()
    password = data.get("password") or ""
    role = (data.get("role") or "stock_manager").strip()

    if not username:
        return "Username is required"
    if len(username) < 3:
        return "Username must be at least 3 characters"
    if not username.replace("_", "").replace("-", "").isalnum():
        return "Username may only contain letters, numbers, hyphens, and underscores"

    if creating and not password:
        return "Password is required"
    if password and len(password) < 6:
        return "Password must be at least 6 characters"

    if not display_name:
        display_name = username

    if role not in ROLES:
        return f"Invalid role. Choose from: {', '.join(ROLES)}"

    return None


def normalize_email(value):
    email = (value or "").strip()
    return email or None


def validate_email(value):
    email = normalize_email(value)
    if email is None:
        return None
    if not EMAIL_RE.fullmatch(email):
        return "Enter a valid email address"
    return None


def password_change_exempt():
    path = request.path
    if path == "/change-password":
        return True
    for prefix in ("/api/auth/change-password", "/api/auth/logout", "/api/auth/me"):
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def pin_change_exempt():
    path = request.path
    if path in ("/", "/login"):
        return True
    for prefix in (
        "/api/auth/pin",
        "/api/auth/logout",
        "/api/auth/me",
        "/static/",
    ):
        if path == prefix or path.startswith(prefix):
            return True
    return False


def _password_change_block_response():
    if request.path.startswith("/api/"):
        return (
            jsonify(
                {
                    "error": "You must change your password before continuing",
                    "must_change_password": True,
                }
            ),
            403,
        )
    return redirect(url_for("change_password"))


def _pin_change_block_response():
    if request.path.startswith("/api/"):
        return (
            jsonify(
                {
                    "error": "You must set a new personal PIN before continuing",
                    "must_change_pin": True,
                }
            ),
            403,
        )
    return redirect(url_for("index"))


def _block_if_password_change_required(user):
    if user and row_to_user(user)["must_change_password"] and not password_change_exempt():
        return _password_change_block_response()
    return None


def _block_if_pin_change_required(user):
    if user and row_to_user(user)["must_change_pin"] and not pin_change_exempt():
        return _pin_change_block_response()
    return None


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        from app import get_db

        user = get_current_user(get_db())
        if user is None:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required"}), 401
            return redirect(url_for("login", next=request.path))
        blocked = _block_if_password_change_required(user)
        if blocked is not None:
            return blocked
        blocked = _block_if_pin_change_required(user)
        if blocked is not None:
            return blocked
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        from app import get_db

        user = get_current_user(get_db())
        if user is None:
            return jsonify({"error": "Authentication required"}), 401
        blocked = _block_if_password_change_required(user)
        if blocked is not None:
            return blocked
        blocked = _block_if_pin_change_required(user)
        if blocked is not None:
            return blocked
        if user["role"] != "admin":
            return jsonify({"error": "Admin access required"}), 403
        return view(*args, **kwargs)

    return wrapped


def role_required(*roles):
    allowed = frozenset(roles)

    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            from app import get_db

            user = get_current_user(get_db())
            if user is None:
                if request.path.startswith("/api/"):
                    return jsonify({"error": "Authentication required"}), 401
                return redirect(url_for("login", next=request.path))
            blocked = _block_if_password_change_required(user)
            if blocked is not None:
                return blocked
            blocked = _block_if_pin_change_required(user)
            if blocked is not None:
                return blocked
            if user["role"] not in allowed:
                return jsonify({"error": "Access denied"}), 403
            return view(*args, **kwargs)

        return wrapped

    return decorator
