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
            is_platform_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_platform_admin IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        """
    )


def row_to_user(row, membership_role=None):
    keys = row.keys()
    pin_value = (row["pin"] or "").strip() if "pin" in keys else ""
    role = membership_role if membership_role is not None else row["role"]
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "email": (row["email"] or "").strip() if "email" in keys else "",
        "role": role,
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
        "is_platform_admin": bool(row["is_platform_admin"])
        if "is_platform_admin" in keys
        else False,
        "has_pin": bool(pin_value),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def public_user(row, membership_role=None):
    data = row_to_user(row, membership_role=membership_role)
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


def pin_taken(db, pin, exclude_user_id=None, business_id=None):
    """Permanent PINs must be unique among active members of the same business."""
    if business_id is None:
        from business import current_business_id

        business_id = current_business_id()
    if business_id is None:
        query = """SELECT id FROM users
                   WHERE pin = ?
                     AND IFNULL(must_change_pin, 0) = 0"""
        params = [pin]
        if exclude_user_id is not None:
            query += " AND id != ?"
            params.append(exclude_user_id)
        return db.execute(query, params).fetchone() is not None

    query = """
        SELECT u.id
        FROM users u
        JOIN user_business_memberships m ON m.user_id = u.id
        WHERE u.pin = ?
          AND IFNULL(u.must_change_pin, 0) = 0
          AND m.business_id = ?
          AND m.is_active = 1
    """
    params = [pin, business_id]
    if exclude_user_id is not None:
        query += " AND u.id != ?"
        params.append(exclude_user_id)
    return db.execute(query, params).fetchone() is not None


def active_membership_role(db, user_id, business_id):
    if not user_id or not business_id:
        return None
    from business import get_membership

    membership = get_membership(db, user_id, business_id)
    if not membership:
        return None
    if not membership["is_active"] or not membership["business_is_active"]:
        return None
    return membership["role"]


def get_current_user(db):
    user_id = session.get("user_id")
    if not user_id:
        return None
    row = get_user_by_id(db, user_id)
    if not row or not row["is_active"]:
        session.clear()
        return None

    from business import current_business_id, get_membership

    business_id = current_business_id()
    if business_id is None:
        # Platform-only session without a shop context is allowed for platform admins.
        if row_to_user(row).get("is_platform_admin"):
            return row
        session.clear()
        return None

    membership = get_membership(db, user_id, business_id)
    if not membership or not membership["is_active"] or not membership["business_is_active"]:
        if row_to_user(row).get("is_platform_admin"):
            return row
        session.clear()
        return None
    return row


def current_user_role(db, user=None):
    if user is None:
        user = get_current_user(db)
    if user is None:
        return None
    from business import current_business_id

    business_id = current_business_id()
    role = active_membership_role(db, user["id"], business_id)
    if role:
        return role
    if row_to_user(user).get("is_platform_admin"):
        return "admin"
    return user["role"]


def login_user(user_id, business_id=None):
    session.clear()
    session["user_id"] = user_id
    if business_id is not None:
        session["business_id"] = int(business_id)
    session.permanent = True


def logout_user():
    session.clear()


def hash_password(password):
    return generate_password_hash(password)


def verify_password(password_hash, password):
    return check_password_hash(password_hash, password)


def verify_admin_password(db, password, business_id=None):
    if not password:
        return False
    from business import current_business_id

    if business_id is None:
        business_id = current_business_id()

    # Platform admins can always verify.
    platform_rows = db.execute(
        """SELECT password_hash FROM users
           WHERE is_platform_admin = 1 AND is_active = 1"""
    ).fetchall()
    if any(verify_password(row["password_hash"], password) for row in platform_rows):
        return True

    if business_id is None:
        return False

    rows = db.execute(
        """SELECT u.password_hash
           FROM users u
           JOIN user_business_memberships m ON m.user_id = u.id
           WHERE m.business_id = ?
             AND m.role = 'admin'
             AND m.is_active = 1
             AND u.is_active = 1""",
        (business_id,),
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
        "/api/auth/switch-business",
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
        if current_user_role(db, user) != "admin" and not row_to_user(user).get(
            "is_platform_admin"
        ):
            return jsonify({"error": "Admin access required"}), 403
        return view(*args, **kwargs)

    return wrapped


def role_required(*roles):
    allowed = frozenset(roles)

    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            from app import get_db

            db = get_db()
            user = get_current_user(db)
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
            role = current_user_role(db, user)
            if role not in allowed and not (
                row_to_user(user).get("is_platform_admin") and "admin" in allowed
            ):
                # Platform admins may act as admin in any business context.
                if row_to_user(user).get("is_platform_admin") and allowed & {
                    "admin",
                    "supervisor",
                    "stock_manager",
                }:
                    return view(*args, **kwargs)
                return jsonify({"error": "Access denied"}), 403
            return view(*args, **kwargs)

        return wrapped

    return decorator
