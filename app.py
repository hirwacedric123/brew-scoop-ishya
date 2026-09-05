"""Brew & Scoop Stock Management — Flask backend."""

import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

from env_loader import load_env_file

load_env_file()

from flask import Flask, jsonify, redirect, render_template, request, g, session, url_for
from werkzeug.security import generate_password_hash

from auth import (
    ROLES,
    admin_required,
    get_current_user,
    get_user_by_id,
    get_user_by_pin,
    get_user_by_username,
    hash_password,
    init_users_table,
    login_required,
    login_user,
    logout_user,
    normalize_email,
    normalize_pin,
    pin_taken,
    public_user,
    role_required,
    row_to_user,
    validate_email,
    validate_pin,
    validate_user_payload,
    verify_password,
    verify_admin_password,
)
from password_reset import (
    find_valid_reset_token,
    init_password_reset_table,
    mark_reset_token_used,
    request_password_reset,
)
from reporting import (
    category_breakdown as _category_breakdown,
    extra_report_emails,
    get_database_path,
    payment_breakdown as _payment_breakdown,
    render_shift_close_html,
    render_shift_close_text,
    report_recipients,
    sales_summary as _sales_summary,
)
from mailer import send_email

app = Flask(__name__)
app.config["DATABASE"] = get_database_path()
app.config["SECRET_KEY"] = os.environ.get(
    "BREW_SCOOP_SECRET_KEY", "dev-change-me-in-production"
)
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=7)

KIGALI_OFFSET = timedelta(hours=2)

PAYMENT_METHODS = {
    "momo": "MoMo",
    "cash": "Cash",
    "visa": "Visa",
}

DEFAULT_CATEGORIES = (
    {"name": "Shared Cups", "uses_cup_stock": 1, "sort_order": 0},
    {"name": "Individuals", "uses_cup_stock": 0, "sort_order": 1},
)
DEFAULT_CATEGORY_NAMES = frozenset(c["name"] for c in DEFAULT_CATEGORIES)


def is_default_category(name):
    if not name:
        return False
    lowered = name.casefold()
    return any(n.casefold() == lowered for n in DEFAULT_CATEGORY_NAMES)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(app.config["DATABASE"])
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            price REAL NOT NULL CHECK(price >= 0),
            quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
            reorder_level INTEGER NOT NULL DEFAULT 10 CHECK(reorder_level >= 0),
            sku TEXT,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('sale', 'restock', 'adjustment')),
            quantity INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            total_amount REAL NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL,
            checkout_ref TEXT,
            payment_method TEXT,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
        CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
        """
    )
    _init_categories_table(db)
    init_users_table(db)
    init_password_reset_table(db)
    _migrate_db(db)
    _seed_categories(db)
    _seed_default_admin(db)
    db.commit()
    db.close()


def _migrate_db(db):
    cols = {row[1] for row in db.execute("PRAGMA table_info(transactions)").fetchall()}
    if "checkout_ref" not in cols:
        db.execute("ALTER TABLE transactions ADD COLUMN checkout_ref TEXT")
    if "payment_method" not in cols:
        db.execute("ALTER TABLE transactions ADD COLUMN payment_method TEXT")
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_transactions_checkout ON transactions(checkout_ref)"
    )

    cat_cols = set()
    if db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='categories'"
    ).fetchone():
        cat_cols = {row[1] for row in db.execute("PRAGMA table_info(categories)").fetchall()}
    if "uses_cup_stock" not in cat_cols:
        db.execute(
            "ALTER TABLE categories ADD COLUMN uses_cup_stock INTEGER NOT NULL DEFAULT 0"
        )

    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS cup_inventory (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
            reorder_level INTEGER NOT NULL DEFAULT 20 CHECK(reorder_level >= 0),
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cup_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK(type IN ('restock', 'adjustment', 'sale')),
            quantity INTEGER NOT NULL,
            notes TEXT,
            checkout_ref TEXT,
            created_at TEXT NOT NULL
        );
        """
    )
    if not db.execute("SELECT 1 FROM cup_inventory WHERE id = 1").fetchone():
        db.execute(
            "INSERT INTO cup_inventory (id, quantity, reorder_level, updated_at) VALUES (1, 0, 20, ?)",
            (now_iso(),),
        )

    tx_cols = {row[1] for row in db.execute("PRAGMA table_info(transactions)").fetchall()}
    if "user_id" not in tx_cols:
        db.execute("ALTER TABLE transactions ADD COLUMN user_id INTEGER REFERENCES users(id)")

    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS seller_shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
            opened_at TEXT NOT NULL,
            closed_at TEXT,
            opening_float REAL NOT NULL DEFAULT 0,
            counted_cash REAL,
            expected_cash REAL,
            variance REAL,
            total_sales REAL,
            cash_sales REAL,
            momo_sales REAL,
            visa_sales REAL,
            units_sold INTEGER,
            sale_count INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_seller_shifts_user_status
            ON seller_shifts(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_seller_shifts_user_opened
            ON seller_shifts(user_id, opened_at);
        """
    )

    if "shift_id" not in tx_cols:
        db.execute(
            "ALTER TABLE transactions ADD COLUMN shift_id INTEGER REFERENCES seller_shifts(id)"
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_transactions_shift ON transactions(shift_id)"
        )

    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS seller_reconciliations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            sale_date TEXT NOT NULL,
            counted_cash REAL NOT NULL,
            expected_cash REAL NOT NULL,
            variance REAL NOT NULL,
            total_sales REAL NOT NULL,
            cash_sales REAL NOT NULL,
            momo_sales REAL NOT NULL,
            visa_sales REAL NOT NULL,
            units_sold INTEGER NOT NULL,
            sale_count INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, sale_date)
        );

        CREATE INDEX IF NOT EXISTS idx_seller_recon_user_date
            ON seller_reconciliations(user_id, sale_date);
        """
    )

    _migrate_users_role_check(db)

    user_cols = {row[1] for row in db.execute("PRAGMA table_info(users)").fetchall()}
    if "email" not in user_cols:
        db.execute("ALTER TABLE users ADD COLUMN email TEXT")
    if "must_change_password" not in user_cols:
        db.execute(
            "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"
        )

    _migrate_users_supervisor_role(db)

    # PIN column after role migrations so table rebuilds don't drop it.
    user_cols = {row[1] for row in db.execute("PRAGMA table_info(users)").fetchall()}
    if "pin" not in user_cols:
        db.execute("ALTER TABLE users ADD COLUMN pin TEXT")
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pin ON users(pin) "
        "WHERE pin IS NOT NULL AND pin != ''"
    )

    init_password_reset_table(db)

    shift_cols = {
        row[1] for row in db.execute("PRAGMA table_info(seller_shifts)").fetchall()
    }
    for col in (
        "cash_notes_5000",
        "cash_notes_2000",
        "cash_notes_1000",
        "cash_notes_500",
        "cash_notes_100",
        "cash_notes_50",
    ):
        if col not in shift_cols:
            db.execute(
                f"ALTER TABLE seller_shifts ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0"
            )
    for col in (
        "counted_momo",
        "counted_visa",
        "expected_momo",
        "expected_visa",
        "momo_variance",
        "visa_variance",
    ):
        if col not in shift_cols:
            db.execute(f"ALTER TABLE seller_shifts ADD COLUMN {col} REAL")
    if "concerns" not in shift_cols:
        db.execute("ALTER TABLE seller_shifts ADD COLUMN concerns TEXT")
    for col in ("report_low_stock", "report_issues", "report_wishes"):
        if col not in shift_cols:
            db.execute(f"ALTER TABLE seller_shifts ADD COLUMN {col} TEXT")

    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS shift_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shift_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role_on_shift TEXT NOT NULL CHECK(role_on_shift IN ('supervisor', 'member')),
            joined_at TEXT NOT NULL,
            left_at TEXT,
            FOREIGN KEY (shift_id) REFERENCES seller_shifts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(shift_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_shift_members_user
            ON shift_members(user_id, left_at);
        CREATE INDEX IF NOT EXISTS idx_shift_members_shift
            ON shift_members(shift_id);
        """
    )
    _backfill_shift_members(db)

    tx_cols = {row[1] for row in db.execute("PRAGMA table_info(transactions)").fetchall()}
    if "voided_at" not in tx_cols:
        db.execute("ALTER TABLE transactions ADD COLUMN voided_at TEXT")
    if "voided_by" not in tx_cols:
        db.execute(
            "ALTER TABLE transactions ADD COLUMN voided_by INTEGER REFERENCES users(id)"
        )

    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS seller_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            logged_in_at TEXT NOT NULL,
            logged_out_at TEXT,
            last_heartbeat_at TEXT NOT NULL,
            logout_reason TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_seller_sessions_user_login
            ON seller_sessions(user_id, logged_in_at);
        CREATE INDEX IF NOT EXISTS idx_seller_sessions_user_open
            ON seller_sessions(user_id, logged_out_at);
        """
    )


def _backfill_shift_members(db):
    """Ensure every existing shift has its owner recorded as shift supervisor."""
    missing = db.execute(
        """SELECT s.id, s.user_id, s.opened_at, s.closed_at, s.status
           FROM seller_shifts s
           WHERE NOT EXISTS (
               SELECT 1 FROM shift_members m WHERE m.shift_id = s.id
           )"""
    ).fetchall()
    for row in missing:
        left_at = row["closed_at"] if row["status"] == "closed" else None
        db.execute(
            """INSERT INTO shift_members
               (shift_id, user_id, role_on_shift, joined_at, left_at)
               VALUES (?, ?, 'supervisor', ?, ?)""",
            (row["id"], row["user_id"], row["opened_at"], left_at),
        )


def _migrate_users_role_check(db):
    sql_row = db.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
    ).fetchone()
    if not sql_row or "seller" in (sql_row[0] or ""):
        return
    db.executescript(
        """
        CREATE TABLE users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'stock_manager', 'seller')),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO users_new SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        """
    )


def _migrate_users_supervisor_role(db):
    """Rebuild the users table so the role CHECK constraint allows 'supervisor'."""
    sql_row = db.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
    ).fetchone()
    if not sql_row or "supervisor" in (sql_row[0] or ""):
        return
    db.executescript(
        """
        CREATE TABLE users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            email TEXT,
            role TEXT NOT NULL CHECK(role IN ('admin', 'supervisor', 'stock_manager', 'seller')),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
            must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO users_new
            (id, username, password_hash, display_name, email, role,
             is_active, must_change_password, created_at, updated_at)
            SELECT id, username, password_hash, display_name, email, role,
                   is_active, must_change_password, created_at, updated_at
            FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        """
    )


def _init_categories_table(db):
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order);
        """
    )


def _seed_categories(db):
    ts = now_iso()
    for cat in DEFAULT_CATEGORIES:
        existing = db.execute(
            "SELECT id FROM categories WHERE name = ? COLLATE NOCASE", (cat["name"],)
        ).fetchone()
        if existing:
            continue
        db.execute(
            """INSERT INTO categories (name, sort_order, uses_cup_stock, created_at)
               VALUES (?, ?, ?, ?)""",
            (cat["name"], cat["sort_order"], cat["uses_cup_stock"], ts),
        )


def get_category_names(db):
    rows = db.execute(
        "SELECT name FROM categories ORDER BY sort_order ASC, name COLLATE NOCASE ASC"
    ).fetchall()
    return [row["name"] for row in rows]


def get_category_cup_map(db):
    rows = db.execute("SELECT name, uses_cup_stock FROM categories").fetchall()
    return {row["name"]: bool(row["uses_cup_stock"]) for row in rows}


def category_uses_cups(db, category_name):
    row = db.execute(
        "SELECT uses_cup_stock FROM categories WHERE name = ? COLLATE NOCASE",
        (category_name,),
    ).fetchone()
    return bool(row and row["uses_cup_stock"])


def get_cup_inventory(db):
    row = db.execute("SELECT * FROM cup_inventory WHERE id = 1").fetchone()
    if row is None:
        ts = now_iso()
        db.execute(
            "INSERT INTO cup_inventory (id, quantity, reorder_level, updated_at) VALUES (1, 0, 20, ?)",
            (ts,),
        )
        db.commit()
        row = db.execute("SELECT * FROM cup_inventory WHERE id = 1").fetchone()
    return row


def row_to_cup_inventory(row):
    return {
        "quantity": row["quantity"],
        "reorder_level": row["reorder_level"],
        "stock_status": _stock_status(row["quantity"], row["reorder_level"]),
        "updated_at": row["updated_at"],
    }


def row_to_category(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "sort_order": row["sort_order"],
        "product_count": row["product_count"],
        "uses_cup_stock": bool(row["uses_cup_stock"]),
        "is_default": is_default_category(row["name"]),
        "created_at": row["created_at"],
    }


def _seed_default_admin(db):
    count = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    if count > 0:
        return

    username = os.environ.get("BREW_SCOOP_ADMIN_USERNAME", "admin")
    password = os.environ.get("BREW_SCOOP_ADMIN_PASSWORD", "admin@123")
    display_name = os.environ.get("BREW_SCOOP_ADMIN_NAME", "Administrator")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    db.execute(
        """INSERT INTO users
           (username, password_hash, display_name, role, is_active, created_at, updated_at)
           VALUES (?, ?, ?, 'admin', 1, ?, ?)""",
        (username, generate_password_hash(password), display_name, ts, ts),
    )


def now_kigali():
    return datetime.now(timezone.utc) + KIGALI_OFFSET


def now_iso():
    return now_kigali().strftime("%Y-%m-%dT%H:%M:%S")


def today_kigali():
    return now_kigali().strftime("%Y-%m-%d")


def parse_date(value):
    if not value or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def week_range_kigali():
    today = now_kigali().date()
    start = today - timedelta(days=today.weekday())
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def month_range_kigali():
    today = now_kigali().date()
    start = today.replace(day=1)
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def row_to_product(row, category_cup_map=None, cup_inventory=None):
    uses_cups = (
        category_cup_map.get(row["category"], False)
        if category_cup_map is not None
        else False
    )
    if uses_cups and cup_inventory is not None:
        effective_qty = cup_inventory["quantity"]
        reorder = cup_inventory["reorder_level"]
    else:
        effective_qty = row["quantity"]
        reorder = row["reorder_level"]

    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "price": round(row["price"], 2),
        "quantity": effective_qty,
        "reorder_level": reorder,
        "uses_cup_stock": uses_cups,
        "description": row["description"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "stock_status": _stock_status(effective_qty, reorder),
    }


def _products_response(db, rows, low_only=False):
    category_cup_map = get_category_cup_map(db)
    cup_inventory = get_cup_inventory(db)
    products = [
        row_to_product(row, category_cup_map, cup_inventory) for row in rows
    ]
    if low_only:
        products = [p for p in products if p["stock_status"] in ("low", "out")]
    return products


def _stock_status(quantity, reorder_level):
    if quantity <= 0:
        return "out"
    if quantity <= reorder_level:
        return "low"
    return "ok"


def _not_voided_clause(alias=""):
    prefix = f"{alias}." if alias else ""
    return f" AND {prefix}voided_at IS NULL"


def row_to_transaction(row):
    seller_name = ""
    if "seller_name" in row.keys() and row["seller_name"]:
        seller_name = row["seller_name"]
    return {
        "id": row["id"],
        "product_id": row["product_id"],
        "product_name": row["product_name"],
        "category": row["category"],
        "type": row["type"],
        "quantity": row["quantity"],
        "unit_price": round(row["unit_price"], 2),
        "total_amount": round(row["total_amount"], 2),
        "notes": row["notes"] or "",
        "checkout_ref": row["checkout_ref"] or "",
        "payment_method": row["payment_method"] or "",
        "user_id": row["user_id"] if row["user_id"] else None,
        "seller_name": seller_name,
        "created_at": row["created_at"],
        "sale_date": row["created_at"][:10],
        "voided_at": row["voided_at"] if "voided_at" in row.keys() else None,
        "is_voided": bool(row["voided_at"] if "voided_at" in row.keys() else None),
    }


def _parse_user_id_filter(user_id):
    if not user_id:
        return None
    try:
        return int(user_id)
    except (TypeError, ValueError):
        return None


def _sale_user_clause(user_id, alias=""):
    uid = _parse_user_id_filter(user_id)
    if uid is None:
        return "", []
    prefix = f"{alias}." if alias else ""
    return f" AND {prefix}user_id = ?", [uid]


def _daily_sales_breakdown(db, date_from, date_to, user_id=None):
    user_clause, user_params = _sale_user_clause(user_id)
    rows = db.execute(
        f"""SELECT substr(created_at, 1, 10) AS sale_date,
                  COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units,
                  COUNT(*) AS transactions
           FROM transactions
           WHERE type = 'sale'{_not_voided_clause()}
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?{user_clause}
           GROUP BY sale_date
           ORDER BY sale_date DESC""",
        (date_from, date_to, *user_params),
    ).fetchall()
    return [
        {
            "date": r["sale_date"],
            "revenue": round(r["revenue"], 2),
            "units": r["units"],
            "transactions": r["transactions"],
        }
        for r in rows
    ]


# ── Pages ──────────────────────────────────────────────────────────────────

@app.route("/login")
def login():
    user = get_current_user(get_db())
    if user is not None:
        if row_to_user(user)["must_change_password"]:
            return render_template("login.html", signed_in_as=public_user(user))
        return redirect(url_for("index"))
    return render_template("login.html")


@app.route("/forgot-password")
def forgot_password_page():
    if get_current_user(get_db()) is not None:
        return redirect(url_for("index"))
    return render_template("forgot-password.html")


@app.route("/reset-password")
def reset_password_page():
    if get_current_user(get_db()) is not None:
        return redirect(url_for("index"))
    token = (request.args.get("token") or "").strip()
    if not token or not find_valid_reset_token(get_db(), token):
        return render_template("reset-password.html", token_valid=False, token="")
    return render_template("reset-password.html", token_valid=True, token=token)


@app.route("/change-password")
@login_required
def change_password():
    user = get_current_user(get_db())
    if not row_to_user(user)["must_change_password"]:
        return redirect(url_for("index"))
    return render_template("change-password.html")


@app.route("/")
@login_required
def index():
    user = get_current_user(get_db())
    return render_template(
        "index.html",
        current_user=public_user(user),
    )


# ── Auth API ───────────────────────────────────────────────────────────────

def _close_open_sessions(db, user_id, reason, exclude_id=None):
    ts = now_iso()
    query = """UPDATE seller_sessions
               SET logged_out_at = ?, logout_reason = ?
               WHERE user_id = ? AND logged_out_at IS NULL"""
    params = [ts, reason, user_id]
    if exclude_id is not None:
        query += " AND id != ?"
        params.append(exclude_id)
    db.execute(query, params)


def _start_seller_session(db, user_id):
    ts = now_iso()
    _close_open_sessions(db, user_id, "superseded")
    cur = db.execute(
        """INSERT INTO seller_sessions (user_id, logged_in_at, last_heartbeat_at)
           VALUES (?, ?, ?)""",
        (user_id, ts, ts),
    )
    db.commit()
    session["seller_session_id"] = cur.lastrowid
    return cur.lastrowid


def _end_seller_session(db, session_id, reason="manual"):
    if not session_id:
        return
    ts = now_iso()
    db.execute(
        """UPDATE seller_sessions SET logged_out_at = ?, logout_reason = ?
           WHERE id = ? AND logged_out_at IS NULL""",
        (ts, reason, session_id),
    )
    db.commit()


def _ensure_attendance_session(db, user_id):
    session_id = session.get("seller_session_id")
    if session_id:
        row = db.execute(
            """SELECT id FROM seller_sessions
               WHERE id = ? AND user_id = ? AND logged_out_at IS NULL""",
            (session_id, user_id),
        ).fetchone()
        if row:
            return session_id
    return _start_seller_session(db, user_id)


def _session_duration_seconds(row):
    start = row["logged_in_at"]
    end = row["logged_out_at"] or row["last_heartbeat_at"]
    if not start or not end:
        return 0
    try:
        start_dt = datetime.strptime(start[:19], "%Y-%m-%dT%H:%M:%S")
        end_dt = datetime.strptime(end[:19], "%Y-%m-%dT%H:%M:%S")
        return max(0, int((end_dt - start_dt).total_seconds()))
    except ValueError:
        return 0


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(silent=True) or {}
    pin = normalize_pin(data.get("pin"))

    if not pin:
        return jsonify({"error": "Enter your PIN to sign in"}), 400

    error, pin = validate_pin(pin)
    if error:
        return jsonify({"error": error}), 400

    db = get_db()
    row = get_user_by_pin(db, pin)
    if not row:
        return jsonify({"error": "Invalid PIN"}), 401

    login_user(row["id"])
    _start_seller_session(db, row["id"])
    user_data = public_user(row)
    return jsonify(
        {
            "user": user_data,
            "must_change_password": user_data.get("must_change_password", False),
        }
    )


@app.route("/api/auth/verify-admin", methods=["POST"])
@login_required
def auth_verify_admin():
    data = request.get_json(silent=True) or {}
    admin_password = data.get("admin_password") or ""

    if not admin_password:
        return jsonify({"error": "Admin password is required"}), 400

    db = get_db()
    if not verify_admin_password(db, admin_password):
        return jsonify({"error": "Invalid admin password"}), 403

    return jsonify({"ok": True})


@app.route("/api/auth/change-password", methods=["POST"])
@login_required
def auth_change_password():
    data = request.get_json(silent=True) or {}
    current_password = data.get("current_password") or ""
    new_password = data.get("new_password") or ""

    if not current_password or not new_password:
        return jsonify({"error": "Current and new passwords are required"}), 400
    if len(new_password) < 6:
        return jsonify({"error": "New password must be at least 6 characters"}), 400

    db = get_db()
    user = get_current_user(db)
    if not verify_password(user["password_hash"], current_password):
        return jsonify({"error": "Current password is incorrect"}), 400
    if current_password == new_password:
        return jsonify({"error": "New password must be different from the current one"}), 400

    ts = now_iso()
    db.execute(
        """UPDATE users SET password_hash=?, must_change_password=0, updated_at=?
           WHERE id=?""",
        (hash_password(new_password), ts, user["id"]),
    )
    db.commit()
    updated = get_user_by_id(db, user["id"])
    return jsonify({"message": "Password updated", "user": public_user(updated)})


@app.route("/api/auth/forgot-password", methods=["POST"])
def auth_forgot_password():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip()
    email_error = validate_email(email)
    if email_error:
        return jsonify({"error": email_error}), 400

    db = get_db()
    try:
        request_password_reset(db, email)
    except Exception:
        db.rollback()
        app.logger.exception("Password reset email failed for %s", email)
        return jsonify({"error": "Could not send reset email. Check SMTP settings."}), 503

    return jsonify(
        {
            "message": (
                "If an account exists with that email, "
                "you will receive a password reset link shortly."
            )
        }
    )


@app.route("/api/auth/reset-password", methods=["POST"])
def auth_reset_password():
    data = request.get_json(silent=True) or {}
    token = (data.get("token") or "").strip()
    new_password = data.get("new_password") or ""

    if not token or not new_password:
        return jsonify({"error": "Token and new password are required"}), 400
    if len(new_password) < 6:
        return jsonify({"error": "New password must be at least 6 characters"}), 400

    db = get_db()
    reset_row = find_valid_reset_token(db, token)
    if not reset_row:
        return jsonify({"error": "This reset link is invalid or has expired"}), 400

    user = get_user_by_id(db, reset_row["user_id"])
    if not user or not user["is_active"]:
        return jsonify({"error": "This reset link is invalid or has expired"}), 400

    ts = now_iso()
    db.execute(
        """UPDATE users SET password_hash=?, must_change_password=0, updated_at=?
           WHERE id=?""",
        (hash_password(new_password), ts, user["id"]),
    )
    mark_reset_token_used(db, reset_row["id"])
    db.commit()
    return jsonify({"message": "Password reset. You can sign in with your new password."})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session_id = session.get("seller_session_id")
    _end_seller_session(get_db(), session_id, "manual")
    logout_user()
    return jsonify({"message": "Logged out"})


@app.route("/api/auth/heartbeat", methods=["POST"])
@login_required
def auth_heartbeat():
    db = get_db()
    user = get_current_user(db)
    session_id = _ensure_attendance_session(db, user["id"])
    ts = now_iso()
    db.execute(
        "UPDATE seller_sessions SET last_heartbeat_at = ? WHERE id = ?",
        (ts, session_id),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/auth/me", methods=["GET"])
@login_required
def auth_me():
    user = get_current_user(get_db())
    return jsonify({"user": public_user(user)})


@app.route("/api/auth/profile", methods=["PUT"])
@login_required
def auth_update_profile():
    db = get_db()
    user = get_current_user(db)
    data = request.get_json(silent=True) or {}

    display_name = (data.get("display_name") or "").strip()
    if not display_name:
        return jsonify({"error": "Display name cannot be empty"}), 400

    email_error = validate_email(data.get("email"))
    if email_error:
        return jsonify({"error": email_error}), 400
    email = normalize_email(data.get("email"))

    db.execute(
        "UPDATE users SET display_name=?, email=?, updated_at=? WHERE id=?",
        (display_name, email, now_iso(), user["id"]),
    )
    db.commit()
    updated = get_user_by_id(db, user["id"])
    return jsonify({"message": "Profile updated", "user": public_user(updated)})


@app.route("/api/auth/pin", methods=["POST"])
@login_required
def auth_set_pin():
    data = request.get_json(silent=True) or {}
    error, pin = validate_pin(data.get("pin"))
    if error:
        return jsonify({"error": error}), 400

    confirm = normalize_pin(data.get("confirm_pin"))
    if confirm and confirm != pin:
        return jsonify({"error": "PINs do not match"}), 400

    db = get_db()
    user = get_current_user(db)
    current_pin = (user["pin"] or "").strip() if "pin" in user.keys() else ""

    if current_pin:
        provided = normalize_pin(data.get("current_pin"))
        if not provided or provided != current_pin:
            return jsonify({"error": "Current PIN is incorrect"}), 400
        if provided == pin:
            return jsonify({"error": "New PIN must be different from the current one"}), 400
    else:
        current_password = data.get("current_password") or ""
        if not current_password or not verify_password(user["password_hash"], current_password):
            return jsonify({"error": "Current password is required to set your first PIN"}), 400

    if pin_taken(db, pin, exclude_user_id=user["id"]):
        return jsonify({"error": "That PIN is already used by another account"}), 409

    db.execute(
        "UPDATE users SET pin=?, updated_at=? WHERE id=?",
        (pin, now_iso(), user["id"]),
    )
    db.commit()
    updated = get_user_by_id(db, user["id"])
    return jsonify({"message": "PIN saved", "user": public_user(updated)})


# ── Admin API ──────────────────────────────────────────────────────────────

@app.route("/api/admin/users", methods=["GET"])
@role_required("admin", "supervisor")
def admin_list_users():
    rows = get_db().execute(
        "SELECT * FROM users ORDER BY role ASC, username ASC"
    ).fetchall()
    return jsonify([row_to_user(r) for r in rows])


@app.route("/api/admin/attendance", methods=["GET"])
@role_required("admin", "supervisor")
def admin_attendance():
    date_from = request.args.get("from", "").strip() or today_kigali()
    date_to = request.args.get("to", "").strip() or date_from
    user_id = _parse_user_id_filter(request.args.get("user_id", "").strip())

    if not parse_date(date_from) or not parse_date(date_to):
        return jsonify({"error": "Invalid date range"}), 400

    query = """
        SELECT s.*, u.display_name, u.username, u.role
        FROM seller_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE substr(s.logged_in_at, 1, 10) >= ?
          AND substr(s.logged_in_at, 1, 10) <= ?
    """
    params = [date_from, date_to]
    if user_id is not None:
        query += " AND s.user_id = ?"
        params.append(user_id)
    query += " ORDER BY s.logged_in_at DESC"

    rows = get_db().execute(query, params).fetchall()
    sessions = []
    for row in rows:
        duration = _session_duration_seconds(row)
        idle_gap = False
        if row["logged_out_at"] and row["last_heartbeat_at"]:
            try:
                end_dt = datetime.strptime(row["logged_out_at"][:19], "%Y-%m-%dT%H:%M:%S")
                hb_dt = datetime.strptime(row["last_heartbeat_at"][:19], "%Y-%m-%dT%H:%M:%S")
                idle_gap = (end_dt - hb_dt).total_seconds() > 900
            except ValueError:
                idle_gap = False
        hours, rem = divmod(duration, 3600)
        mins, secs = divmod(rem, 60)
        if hours:
            duration_label = f"{hours}h {mins}m"
        elif mins:
            duration_label = f"{mins}m {secs}s"
        else:
            duration_label = f"{secs}s"

        sessions.append({
            "id": row["id"],
            "user_id": row["user_id"],
            "display_name": row["display_name"],
            "username": row["username"],
            "role": row["role"],
            "logged_in_at": row["logged_in_at"],
            "logged_out_at": row["logged_out_at"],
            "last_heartbeat_at": row["last_heartbeat_at"],
            "logout_reason": row["logout_reason"],
            "duration_seconds": duration,
            "duration_label": duration_label,
            "is_active": row["logged_out_at"] is None,
            "idle_before_logout": idle_gap,
        })

    return jsonify({
        "from": date_from,
        "to": date_to,
        "sessions": sessions,
    })


@app.route("/api/admin/users", methods=["POST"])
@admin_required
def admin_create_user():
    data = request.get_json(silent=True) or {}
    error = validate_user_payload(data, creating=True)
    if error:
        return jsonify({"error": error}), 400

    db = get_db()
    if get_user_by_username(db, data["username"]):
        return jsonify({"error": "Username already exists"}), 409

    email_error = validate_email(data.get("email"))
    if email_error:
        return jsonify({"error": email_error}), 400
    email = normalize_email(data.get("email"))

    pin = None
    if data.get("pin") not in (None, ""):
        pin_error, pin = validate_pin(data.get("pin"))
        if pin_error:
            return jsonify({"error": pin_error}), 400
        if pin_taken(db, pin):
            return jsonify({"error": "That PIN is already used by another account"}), 409

    ts = now_iso()
    cur = db.execute(
        """INSERT INTO users
           (username, password_hash, display_name, email, role, is_active,
            must_change_password, pin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)""",
        (
            data["username"].strip(),
            hash_password(data["password"]),
            (data.get("display_name") or data["username"]).strip(),
            email,
            data.get("role", "stock_manager"),
            pin,
            ts,
            ts,
        ),
    )
    db.commit()
    row = get_db().execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_user(row)), 201


@app.route("/api/admin/users/<int:user_id>", methods=["PUT"])
@admin_required
def admin_update_user(user_id):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404

    current = get_current_user(db)
    data = request.get_json(silent=True) or {}

    if "display_name" in data:
        display_name = (data.get("display_name") or "").strip()
        if not display_name:
            return jsonify({"error": "Display name cannot be empty"}), 400
    else:
        display_name = row["display_name"]

    if "email" in data:
        email_error = validate_email(data.get("email"))
        if email_error:
            return jsonify({"error": email_error}), 400
        email = normalize_email(data.get("email"))
    else:
        email = normalize_email(row["email"]) if "email" in row.keys() else None

    if "role" in data:
        role = data["role"]
        if role not in ROLES:
            return jsonify({"error": "Invalid role"}), 400
        if current["id"] == user_id and role != "admin":
            return jsonify({"error": "You cannot remove your own admin role"}), 400
    else:
        role = row["role"]

    if "is_active" in data:
        is_active = 1 if data["is_active"] else 0
        if current["id"] == user_id and not is_active:
            return jsonify({"error": "You cannot deactivate your own account"}), 400
    else:
        is_active = row["is_active"]

    password_hash = row["password_hash"]
    if data.get("password"):
        if len(data["password"]) < 6:
            return jsonify({"error": "Password must be at least 6 characters"}), 400
        password_hash = hash_password(data["password"])

    pin = row["pin"] if "pin" in row.keys() else None
    if "pin" in data:
        raw_pin = data.get("pin")
        if raw_pin in (None, ""):
            pin = None
        else:
            pin_error, pin = validate_pin(raw_pin)
            if pin_error:
                return jsonify({"error": pin_error}), 400
            if pin_taken(db, pin, exclude_user_id=user_id):
                return jsonify({"error": "That PIN is already used by another account"}), 409

    ts = now_iso()
    db.execute(
        """UPDATE users SET
           display_name=?, email=?, role=?, is_active=?, password_hash=?, pin=?, updated_at=?
           WHERE id=?""",
        (display_name, email, role, is_active, password_hash, pin, ts, user_id),
    )
    db.commit()
    updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return jsonify(row_to_user(updated))


@app.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@admin_required
def admin_delete_user(user_id):
    db = get_db()
    current = get_current_user(db)
    if current["id"] == user_id:
        return jsonify({"error": "You cannot delete your own account"}), 400

    row = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404

    # Shared shifts owned by this user: hand ownership to another member first
    # so CASCADE does not wipe a live multi-seller shift.
    owned_shifts = db.execute(
        "SELECT id FROM seller_shifts WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    for owned in owned_shifts:
        successor = db.execute(
            """SELECT user_id FROM shift_members
               WHERE shift_id = ? AND user_id != ?
               ORDER BY
                 CASE role_on_shift WHEN 'supervisor' THEN 0 ELSE 1 END,
                 joined_at ASC
               LIMIT 1""",
            (owned["id"], user_id),
        ).fetchone()
        if successor:
            db.execute(
                "UPDATE seller_shifts SET user_id = ? WHERE id = ?",
                (successor["user_id"], owned["id"]),
            )
            db.execute(
                """UPDATE shift_members SET role_on_shift = 'supervisor'
                   WHERE shift_id = ? AND user_id = ?""",
                (owned["id"], successor["user_id"]),
            )
        else:
            db.execute(
                "UPDATE transactions SET shift_id = NULL WHERE shift_id = ?",
                (owned["id"],),
            )

    db.execute("DELETE FROM shift_members WHERE user_id = ?", (user_id,))
    # transactions.user_id, voided_by, and shift_id were added via ALTER TABLE
    # without ON DELETE CASCADE, so NULL them out before deleting the user.
    # shift_id must be cleared first because seller_shifts cascade-deletes with the user.
    db.execute(
        "UPDATE transactions SET shift_id = NULL WHERE shift_id IN "
        "(SELECT id FROM seller_shifts WHERE user_id = ?)",
        (user_id,),
    )
    db.execute("UPDATE transactions SET user_id = NULL WHERE user_id = ?", (user_id,))
    db.execute("UPDATE transactions SET voided_by = NULL WHERE voided_by = ?", (user_id,))
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.commit()
    return jsonify({"message": "User deleted"})


# ── Products API ───────────────────────────────────────────────────────────

@app.route("/api/products", methods=["GET"])
@login_required
def list_products():
    db = get_db()
    search = request.args.get("search", "").strip()
    category = request.args.get("category", "").strip()
    low_only = request.args.get("low_stock") == "1"

    query = "SELECT * FROM products WHERE 1=1"
    params = []

    if search:
        query += " AND (name LIKE ? OR description LIKE ?)"
        like = f"%{search}%"
        params.extend([like, like])
    if category:
        query += " AND category = ?"
        params.append(category)

    query += " ORDER BY name ASC"
    rows = db.execute(query, params).fetchall()
    return jsonify(_products_response(db, rows, low_only=low_only))


@app.route("/api/products/<int:product_id>", methods=["GET"])
@login_required
def get_product(product_id):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found"}), 404
    category_cup_map = get_category_cup_map(db)
    cup_inventory = get_cup_inventory(db)
    return jsonify(row_to_product(row, category_cup_map, cup_inventory))


@app.route("/api/products", methods=["POST"])
@role_required("admin", "stock_manager")
def create_product():
    data = request.get_json(silent=True) or {}
    error = _validate_product(data)
    if error:
        return jsonify({"error": error}), 400

    ts = now_iso()
    db = get_db()
    category = (data.get("category") or "").strip()
    if not category:
        return jsonify({"error": "Category is required"}), 400

    uses_cups = category_uses_cups(db, category)
    quantity = 0 if uses_cups else int(data.get("quantity", 0))

    cur = db.execute(
        """INSERT INTO products
           (name, category, price, quantity, reorder_level, sku, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data["name"].strip(),
            category,
            float(data["price"]),
            quantity,
            int(data.get("reorder_level", 10)),
            None,
            (data.get("description") or "").strip() or None,
            ts,
            ts,
        ),
    )
    if quantity > 0:
        db.execute(
            """INSERT INTO transactions
               (product_id, type, quantity, unit_price, total_amount, notes, created_at)
               VALUES (?, 'restock', ?, ?, ?, ?, ?)""",
            (cur.lastrowid, quantity, float(data["price"]),
             float(data["price"]) * quantity, "Initial stock", ts),
        )
    db.commit()
    row = db.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
    category_cup_map = get_category_cup_map(db)
    cup_inventory = get_cup_inventory(db)
    return jsonify(row_to_product(row, category_cup_map, cup_inventory)), 201


@app.route("/api/products/<int:product_id>", methods=["PUT"])
@role_required("admin", "stock_manager")
def update_product(product_id):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found"}), 404

    data = request.get_json(silent=True) or {}
    error = _validate_product(data, partial=False)
    if error:
        return jsonify({"error": error}), 400

    try:
        new_quantity = int(data.get("quantity", row["quantity"]))
        if new_quantity < 0:
            return jsonify({"error": "Quantity cannot be negative"}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid quantity"}), 400

    category = data.get("category", row["category"])
    uses_cups = category_uses_cups(db, category)
    if uses_cups:
        new_quantity = 0

    ts = now_iso()
    old_quantity = row["quantity"]
    db.execute(
        """UPDATE products SET
           name=?, category=?, price=?, quantity=?, reorder_level=?, sku=?, description=?, updated_at=?
           WHERE id=?""",
        (
            data["name"].strip(),
            category,
            float(data["price"]),
            new_quantity,
            int(data.get("reorder_level", row["reorder_level"])),
            None,
            (data.get("description") or "").strip() or None,
            ts,
            product_id,
        ),
    )

    if not uses_cups and new_quantity != old_quantity:
        diff = new_quantity - old_quantity
        db.execute(
            """INSERT INTO transactions
               (product_id, type, quantity, unit_price, total_amount, notes, created_at)
               VALUES (?, 'adjustment', ?, ?, 0, ?, ?)""",
            (
                product_id,
                diff,
                float(data["price"]),
                f"Updated from product edit ({old_quantity} → {new_quantity})",
                ts,
            ),
        )

    db.commit()
    updated = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    category_cup_map = get_category_cup_map(db)
    cup_inventory = get_cup_inventory(db)
    return jsonify(row_to_product(updated, category_cup_map, cup_inventory))


@app.route("/api/products/<int:product_id>", methods=["DELETE"])
@role_required("admin", "stock_manager")
def delete_product(product_id):
    db = get_db()
    row = db.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found"}), 404
    db.execute("DELETE FROM products WHERE id = ?", (product_id,))
    db.commit()
    return jsonify({"message": "Product deleted"})


def _validate_product(data, partial=False):
    if not data.get("name", "").strip():
        return "Product name is required"
    try:
        price = float(data.get("price", -1))
        if price < 0:
            return "Price must be zero or positive"
    except (TypeError, ValueError):
        return "Invalid price"
    if "quantity" in data:
        try:
            if int(data["quantity"]) < 0:
                return "Quantity cannot be negative"
        except (TypeError, ValueError):
            return "Invalid quantity"
    if "reorder_level" in data:
        try:
            if int(data["reorder_level"]) < 0:
                return "Reorder level cannot be negative"
        except (TypeError, ValueError):
            return "Invalid reorder level"
    category = (data.get("category") or "").strip()
    if not category:
        return "Category is required"
    if category not in get_category_names(get_db()):
        return "Invalid category"
    return None


# ── Sales & Stock API ──────────────────────────────────────────────────────

def _normalize_checkout_items(raw_items):
    if not isinstance(raw_items, list) or not raw_items:
        return None, "Cart is empty"

    merged = {}
    for item in raw_items:
        try:
            product_id = int(item.get("product_id"))
            quantity = int(item.get("quantity"))
        except (TypeError, ValueError):
            return None, "Invalid item in cart"
        if quantity <= 0:
            return None, "Quantity must be greater than zero"
        merged[product_id] = merged.get(product_id, 0) + quantity

    return [{"product_id": pid, "quantity": qty} for pid, qty in merged.items()], None


def _execute_checkout(db, items, notes=None, payment_method=None, user_id=None, shift_id=None):
    method = (payment_method or "").strip().lower()
    if method not in PAYMENT_METHODS:
        return None, "Select a payment method: MoMo, Cash, or Visa", 400

    checkout_ref = (
        f"CHK-{now_kigali().strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3).upper()}"
    )
    ts = now_iso()
    notes_text = (notes or "").strip() or None
    category_cup_map = get_category_cup_map(db)
    cup_inv = get_cup_inventory(db)

    db.execute("BEGIN IMMEDIATE")
    try:
        product_ids = [item["product_id"] for item in items]
        placeholders = ",".join("?" * len(product_ids))
        rows = db.execute(
            f"SELECT * FROM products WHERE id IN ({placeholders})",
            product_ids,
        ).fetchall()
        products = {row["id"]: row for row in rows}

        cup_units_needed = 0
        for item in items:
            product_id = item["product_id"]
            quantity = item["quantity"]
            row = products.get(product_id)
            if row is None:
                db.rollback()
                return None, "Product not found", 404

            if category_cup_map.get(row["category"], False):
                cup_units_needed += quantity
            elif row["quantity"] < quantity:
                db.rollback()
                return None, (
                    f"Insufficient stock for {row['name']}. "
                    f"Only {row['quantity']} available."
                ), 400

        if cup_units_needed > cup_inv["quantity"]:
            db.rollback()
            return None, (
                f"Insufficient cups in stock. Only {cup_inv['quantity']} cup(s) available."
            ), 400

        result_items = []
        total_amount = 0.0
        total_units = 0
        remaining_cups = cup_inv["quantity"]

        for item in items:
            product_id = item["product_id"]
            quantity = item["quantity"]
            row = products[product_id]
            unit_price = float(row["price"])
            line_total = round(unit_price * quantity, 2)
            uses_cups = category_cup_map.get(row["category"], False)

            if uses_cups:
                remaining_cups -= quantity
                new_qty = row["quantity"]
            else:
                new_qty = row["quantity"] - quantity
                db.execute(
                    "UPDATE products SET quantity=?, updated_at=? WHERE id=?",
                    (new_qty, ts, product_id),
                )

            cur = db.execute(
                """INSERT INTO transactions
                   (product_id, type, quantity, unit_price, total_amount,
                    notes, created_at, checkout_ref, payment_method, user_id, shift_id)
                   VALUES (?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    product_id,
                    quantity,
                    unit_price,
                    line_total,
                    notes_text,
                    ts,
                    checkout_ref,
                    method,
                    user_id,
                    shift_id,
                ),
            )

            updated = db.execute(
                "SELECT * FROM products WHERE id = ?", (product_id,)
            ).fetchone()
            display_product = row_to_product(
                updated, category_cup_map, {"quantity": remaining_cups, "reorder_level": cup_inv["reorder_level"]}
            )
            result_items.append({
                "transaction_id": cur.lastrowid,
                "product": display_product,
                "quantity_sold": quantity,
                "unit_price": unit_price,
                "total_amount": line_total,
                "remaining_stock": remaining_cups if uses_cups else new_qty,
            })
            total_amount += line_total
            total_units += quantity
            products[product_id] = updated

        if cup_units_needed > 0:
            db.execute(
                "UPDATE cup_inventory SET quantity=?, updated_at=? WHERE id=1",
                (remaining_cups, ts),
            )
            db.execute(
                """INSERT INTO cup_transactions
                   (type, quantity, notes, checkout_ref, created_at)
                   VALUES ('sale', ?, ?, ?, ?)""",
                (-cup_units_needed, notes_text, checkout_ref, ts),
            )

        db.commit()
        return {
            "checkout_ref": checkout_ref,
            "payment_method": method,
            "payment_label": PAYMENT_METHODS[method],
            "items": result_items,
            "total_amount": round(total_amount, 2),
            "total_units": total_units,
            "line_count": len(result_items),
            "cups_remaining": remaining_cups,
        }, None, 201
    except Exception:
        db.rollback()
        raise


@app.route("/api/sales", methods=["POST"])
@login_required
def create_sale():
    data = request.get_json(silent=True) or {}
    product_id = data.get("product_id")
    quantity = data.get("quantity")

    try:
        quantity = int(quantity)
        if quantity <= 0:
            return jsonify({"error": "Quantity must be greater than zero"}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid quantity"}), 400

    items, error = _normalize_checkout_items(
        [{"product_id": product_id, "quantity": quantity}]
    )
    if error:
        return jsonify({"error": error}), 400

    db = get_db()
    user = get_current_user(db)
    shift_id = None
    if user["role"] == "seller":
        shift = get_open_seller_shift(db, user["id"])
        if not shift:
            return jsonify({"error": "Start or join a shift before selling."}), 400
        shift_id = shift["id"]
    result, error, status = _execute_checkout(
        db, items, data.get("notes"), data.get("payment_method"), user["id"], shift_id
    )
    if error:
        return jsonify({"error": error}), status

    item = result["items"][0]
    return jsonify({
        "transaction_id": item["transaction_id"],
        "checkout_ref": result["checkout_ref"],
        "product": item["product"],
        "quantity_sold": item["quantity_sold"],
        "unit_price": item["unit_price"],
        "total_amount": item["total_amount"],
        "remaining_stock": item["remaining_stock"],
        "payment_method": result.get("payment_method"),
        "payment_label": result.get("payment_label"),
    }), status


@app.route("/api/sales/checkout", methods=["POST"])
@role_required("seller", "stock_manager")
def checkout_sale():
    data = request.get_json(silent=True) or {}
    items, error = _normalize_checkout_items(data.get("items"))
    if error:
        return jsonify({"error": error}), 400

    db = get_db()
    user = get_current_user(db)
    shift_id = None
    if user["role"] == "seller":
        shift = get_open_seller_shift(db, user["id"])
        if not shift:
            return jsonify({"error": "Start or join a shift before selling."}), 400
        shift_id = shift["id"]
    result, error, status = _execute_checkout(
        db, items, data.get("notes"), data.get("payment_method"), user["id"], shift_id
    )
    if error:
        return jsonify({"error": error}), status
    return jsonify(result), status


def _execute_void_sale(db, checkout_ref, voided_by_user_id):
    checkout_ref = (checkout_ref or "").strip()
    if not checkout_ref:
        return None, "Sale reference is required", 400

    rows = db.execute(
        """SELECT t.*, p.category
           FROM transactions t
           JOIN products p ON p.id = t.product_id
           WHERE t.type = 'sale' AND t.checkout_ref = ? AND t.voided_at IS NULL""",
        (checkout_ref,),
    ).fetchall()
    if not rows:
        existing = db.execute(
            """SELECT 1 FROM transactions
               WHERE type = 'sale' AND checkout_ref = ? AND voided_at IS NOT NULL
               LIMIT 1""",
            (checkout_ref,),
        ).fetchone()
        if existing:
            return None, "Sale already voided", 409
        return None, "Sale not found", 404

    ts = now_iso()
    category_cup_map = get_category_cup_map(db)
    cup_inv = get_cup_inventory(db)
    cup_units_restore = 0

    db.execute("BEGIN IMMEDIATE")
    try:
        for row in rows:
            quantity = row["quantity"]
            product_id = row["product_id"]
            uses_cups = category_cup_map.get(row["category"], False)

            if uses_cups:
                cup_units_restore += quantity
            else:
                product = db.execute(
                    "SELECT quantity FROM products WHERE id = ?", (product_id,)
                ).fetchone()
                new_qty = product["quantity"] + quantity
                db.execute(
                    "UPDATE products SET quantity=?, updated_at=? WHERE id=?",
                    (new_qty, ts, product_id),
                )

        if cup_units_restore > 0:
            new_cups = cup_inv["quantity"] + cup_units_restore
            db.execute(
                "UPDATE cup_inventory SET quantity=?, updated_at=? WHERE id=1",
                (new_cups, ts),
            )
            db.execute(
                """INSERT INTO cup_transactions
                   (type, quantity, notes, checkout_ref, created_at)
                   VALUES ('adjustment', ?, ?, ?, ?)""",
                (
                    cup_units_restore,
                    f"Void sale {checkout_ref}",
                    checkout_ref,
                    ts,
                ),
            )

        db.execute(
            """UPDATE transactions SET voided_at = ?, voided_by = ?
               WHERE type = 'sale' AND checkout_ref = ? AND voided_at IS NULL""",
            (ts, voided_by_user_id, checkout_ref),
        )
        db.commit()
        return {
            "checkout_ref": checkout_ref,
            "voided_at": ts,
            "lines_voided": len(rows),
        }, None, 200
    except Exception:
        db.rollback()
        raise


@app.route("/api/sales/void", methods=["POST"])
@login_required
def void_sale():
    data = request.get_json(silent=True) or {}
    checkout_ref = (data.get("checkout_ref") or "").strip()
    admin_password = data.get("admin_password") or ""

    if not admin_password:
        return jsonify({"error": "Admin password is required"}), 400

    db = get_db()
    user = get_current_user(db)

    if not verify_admin_password(db, admin_password):
        return jsonify({"error": "Invalid admin password"}), 403

    owner_row = db.execute(
        """SELECT user_id FROM transactions
           WHERE type = 'sale' AND checkout_ref = ? AND voided_at IS NULL
           LIMIT 1""",
        (checkout_ref,),
    ).fetchone()
    if not owner_row:
        existing = db.execute(
            """SELECT 1 FROM transactions
               WHERE type = 'sale' AND checkout_ref = ? AND voided_at IS NOT NULL
               LIMIT 1""",
            (checkout_ref,),
        ).fetchone()
        if existing:
            return jsonify({"error": "Sale already voided"}), 409
        return jsonify({"error": "Sale not found"}), 404

    if user["role"] == "seller" and owner_row["user_id"] != user["id"]:
        return jsonify({"error": "You can only void your own sales"}), 403

    result, error, status = _execute_void_sale(db, checkout_ref, user["id"])
    if error:
        return jsonify({"error": error}), status
    return jsonify({**result, "message": "Sale voided and stock restored"})


def get_open_store_shift(db):
    """Return the single open store shift, if any."""
    return db.execute(
        """SELECT * FROM seller_shifts
           WHERE status = 'open'
           ORDER BY opened_at ASC
           LIMIT 1"""
    ).fetchone()


def get_open_seller_shift(db, user_id):
    """Return the open shift this seller is currently a member of."""
    return db.execute(
        """SELECT s.*
           FROM seller_shifts s
           JOIN shift_members m ON m.shift_id = s.id
           WHERE s.status = 'open'
             AND m.user_id = ?
             AND m.left_at IS NULL
           ORDER BY s.opened_at DESC
           LIMIT 1""",
        (user_id,),
    ).fetchone()


def get_shift_membership(db, shift_id, user_id):
    return db.execute(
        """SELECT * FROM shift_members
           WHERE shift_id = ? AND user_id = ? AND left_at IS NULL""",
        (shift_id, user_id),
    ).fetchone()


def _list_shift_members(db, shift_id):
    rows = db.execute(
        """SELECT m.user_id, m.role_on_shift, m.joined_at, m.left_at,
                  u.display_name
           FROM shift_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.shift_id = ?
           ORDER BY
             CASE m.role_on_shift WHEN 'supervisor' THEN 0 ELSE 1 END,
             m.joined_at ASC""",
        (shift_id,),
    ).fetchall()
    return [
        {
            "user_id": row["user_id"],
            "display_name": row["display_name"],
            "role_on_shift": row["role_on_shift"],
            "joined_at": row["joined_at"],
            "left_at": row["left_at"],
            "active": row["left_at"] is None,
        }
        for row in rows
    ]


def _add_shift_member(db, shift_id, user_id, role_on_shift, joined_at):
    db.execute(
        """INSERT INTO shift_members
           (shift_id, user_id, role_on_shift, joined_at, left_at)
           VALUES (?, ?, ?, ?, NULL)""",
        (shift_id, user_id, role_on_shift, joined_at),
    )


def _shift_payload_for_user(db, row, user_id, include_close=False):
    data = _row_to_shift(row, include_close=include_close)
    members = _list_shift_members(db, row["id"])
    active = [m for m in members if m["active"]]
    membership = next((m for m in active if m["user_id"] == user_id), None)
    supervisor = next(
        (m for m in members if m["role_on_shift"] == "supervisor"),
        None,
    )
    my_role = membership["role_on_shift"] if membership else None
    data["members"] = members
    data["active_members"] = active
    data["supervisor_user_id"] = row["user_id"]
    data["supervisor_name"] = (
        supervisor["display_name"] if supervisor else None
    )
    data["my_role_on_shift"] = my_role
    data["can_close"] = my_role == "supervisor" and row["status"] == "open"
    return data


def _joinable_shift_summary(db, row):
    members = _list_shift_members(db, row["id"])
    active = [m for m in members if m["active"]]
    supervisor = next(
        (m for m in active if m["role_on_shift"] == "supervisor"),
        None,
    )
    return {
        "id": row["id"],
        "opened_at": row["opened_at"],
        "supervisor_name": supervisor["display_name"] if supervisor else None,
        "member_count": len(active),
        "members": [
            {
                "user_id": m["user_id"],
                "display_name": m["display_name"],
                "role_on_shift": m["role_on_shift"],
            }
            for m in active
        ],
    }


def _last_closed_shift_for_user(db, user_id):
    return db.execute(
        """SELECT s.*
           FROM seller_shifts s
           JOIN shift_members m ON m.shift_id = s.id
           WHERE s.status = 'closed' AND m.user_id = ?
           ORDER BY s.closed_at DESC
           LIMIT 1""",
        (user_id,),
    ).fetchone()


CASH_DENOMINATIONS = (5000, 2000, 1000, 500, 100, 50)


def _parse_cash_notes(data):
    notes = data.get("cash_notes") if isinstance(data, dict) else None
    if notes is None:
        notes = {}
    result = {}
    for denom in CASH_DENOMINATIONS:
        key = str(denom)
        try:
            count = int(notes.get(key, 0))
        except (TypeError, ValueError):
            return None, f"Invalid count for {denom:,} RWF"
        if count < 0:
            return None, "Note counts cannot be negative"
        result[denom] = count
    return result, None


def _cash_total_from_notes(notes_dict):
    return sum(denom * count for denom, count in notes_dict.items())


def _cash_notes_from_row(row):
    return {
        "5000": row["cash_notes_5000"] or 0,
        "2000": row["cash_notes_2000"] or 0,
        "1000": row["cash_notes_1000"] or 0,
        "500": row["cash_notes_500"] or 0,
        "100": row["cash_notes_100"] or 0,
        "50": (row["cash_notes_50"] if "cash_notes_50" in row.keys() else 0) or 0,
    }


def _seller_sales_for_shift(db, shift_id):
    row = db.execute(
        f"""SELECT
               COALESCE(SUM(total_amount), 0) AS total_sales,
               COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END), 0) AS cash_sales,
               COALESCE(SUM(CASE WHEN payment_method = 'momo' THEN total_amount ELSE 0 END), 0) AS momo_sales,
               COALESCE(SUM(CASE WHEN payment_method = 'visa' THEN total_amount ELSE 0 END), 0) AS visa_sales,
               COALESCE(SUM(quantity), 0) AS units_sold,
               COUNT(*) AS sale_count
           FROM transactions
           WHERE type = 'sale' AND shift_id = ?{_not_voided_clause()}""",
        (shift_id,),
    ).fetchone()
    return {
        "total_sales": round(row["total_sales"], 2),
        "cash_sales": round(row["cash_sales"], 2),
        "momo_sales": round(row["momo_sales"], 2),
        "visa_sales": round(row["visa_sales"], 2),
        "units_sold": row["units_sold"],
        "sale_count": row["sale_count"],
    }


def _shift_sales_for_response(db, shift_id):
    rows = db.execute(
        """SELECT t.*, p.name AS product_name, p.category
           FROM transactions t
           JOIN products p ON p.id = t.product_id
           WHERE t.type = 'sale' AND t.shift_id = ?
           ORDER BY t.created_at DESC, t.id DESC""",
        (shift_id,),
    ).fetchall()
    return [row_to_transaction(r) for r in rows]


def _parse_counted_amount(data, key, label):
    if not isinstance(data, dict):
        return None, f"Invalid {label} amount"
    raw = data.get(key)
    if raw is None or raw == "":
        return 0.0, None
    try:
        amount = float(raw)
    except (TypeError, ValueError):
        return None, f"Invalid {label} amount"
    if amount < 0:
        return None, f"{label} amount cannot be negative"
    return round(amount, 2), None


def _shift_overall_status(cash_variance, momo_variance, visa_variance):
    variances = [cash_variance or 0, momo_variance or 0, visa_variance or 0]
    if all(v == 0 for v in variances):
        return "balanced"
    if any(v < 0 for v in variances):
        return "short"
    return "over"


def _payment_reconcile_message(label, counted, expected, variance):
    if variance == 0:
        return f"{label}: {fmt_rwf(counted)} matches recorded sales."
    if variance > 0:
        return (
            f"{label}: counted {fmt_rwf(counted)} — "
            f"{fmt_rwf(abs(variance))} over the {fmt_rwf(expected)} recorded."
        )
    return (
        f"{label}: counted {fmt_rwf(counted)} — "
        f"short by {fmt_rwf(abs(variance))} vs {fmt_rwf(expected)} recorded."
    )


def _shift_report_fields(row):
    keys = row.keys()
    return {
        "concerns": row["concerns"] if "concerns" in keys else None,
        "report_low_stock": row["report_low_stock"] if "report_low_stock" in keys else None,
        "report_issues": row["report_issues"] if "report_issues" in keys else None,
        "report_wishes": row["report_wishes"] if "report_wishes" in keys else None,
    }


def _row_to_shift(row, include_close=False):
    data = {
        "id": row["id"],
        "status": row["status"],
        "opened_at": row["opened_at"],
    }
    data.update(_shift_report_fields(row))
    if include_close or row["status"] == "closed":
        cash_variance = round(row["variance"] or 0, 2)
        momo_variance = round(row["momo_variance"] or 0, 2)
        visa_variance = round(row["visa_variance"] or 0, 2)
        data.update({
            "closed_at": row["closed_at"],
            "counted_cash": round(row["counted_cash"] or 0, 2),
            "counted_total": round(row["counted_cash"] or 0, 2),
            "expected_cash": round(row["expected_cash"] or 0, 2),
            "expected_total": round(row["expected_cash"] or 0, 2),
            "variance": cash_variance,
            "counted_momo": round(row["counted_momo"] or 0, 2),
            "expected_momo": round(row["expected_momo"] or row["momo_sales"] or 0, 2),
            "momo_variance": momo_variance,
            "counted_visa": round(row["counted_visa"] or 0, 2),
            "expected_visa": round(row["expected_visa"] or row["visa_sales"] or 0, 2),
            "visa_variance": visa_variance,
            "total_sales": round(row["total_sales"] or 0, 2),
            "cash_sales": round(row["cash_sales"] or 0, 2),
            "momo_sales": round(row["momo_sales"] or 0, 2),
            "visa_sales": round(row["visa_sales"] or 0, 2),
            "units_sold": row["units_sold"] or 0,
            "sale_count": row["sale_count"] or 0,
            "status_label": _shift_overall_status(
                cash_variance, momo_variance, visa_variance
            ),
            "cash_notes": _cash_notes_from_row(row),
        })
    return data


def _shift_with_sales(db, row, include_close=False):
    data = _row_to_shift(row, include_close=include_close)
    if include_close or row["status"] == "closed":
        data["sales"] = _shift_sales_for_response(db, row["id"])
    return data


def _shift_variance_status(variance):
    if variance == 0:
        return "balanced"
    if variance > 0:
        return "over"
    return "short"


def fmt_rwf(amount):
    return f"RWF {amount:,.0f}"


def _shift_close_message(row):
    cash_variance = row["variance"] or 0
    momo_variance = row["momo_variance"] or 0
    visa_variance = row["visa_variance"] or 0
    parts = [
        _payment_reconcile_message(
            "Cash",
            row["counted_cash"] or 0,
            row["expected_cash"] or 0,
            cash_variance,
        ),
        _payment_reconcile_message(
            "MoMo",
            row["counted_momo"] or 0,
            row["expected_momo"] or row["momo_sales"] or 0,
            momo_variance,
        ),
        _payment_reconcile_message(
            "Visa",
            row["counted_visa"] or 0,
            row["expected_visa"] or row["visa_sales"] or 0,
            visa_variance,
        ),
    ]
    overall = _shift_overall_status(cash_variance, momo_variance, visa_variance)
    if overall == "balanced":
        return "All payment counts match the sales recorded for this shift."
    return " ".join(parts)


@app.route("/api/seller/shift", methods=["GET"])
@role_required("seller")
def seller_shift_status():
    db = get_db()
    user = get_current_user(db)
    open_shift = get_open_seller_shift(db, user["id"])
    if open_shift:
        shift_data = _shift_payload_for_user(db, open_shift, user["id"])
        return jsonify({
            "has_open_shift": True,
            "can_close": shift_data["can_close"],
            "my_role_on_shift": shift_data["my_role_on_shift"],
            "shift": shift_data,
        })

    store_shift = get_open_store_shift(db)
    last_closed = _last_closed_shift_for_user(db, user["id"])

    payload = {"has_open_shift": False, "can_close": False, "my_role_on_shift": None}
    if store_shift:
        payload["joinable_shift"] = _joinable_shift_summary(db, store_shift)
    if last_closed:
        closed = _shift_with_sales(db, last_closed, include_close=True)
        closed_payload = _shift_payload_for_user(
            db, last_closed, user["id"], include_close=True
        )
        closed_payload["sales"] = closed.get("sales", [])
        payload["last_closed"] = closed_payload
    return jsonify(payload)


@app.route("/api/seller/shift/start", methods=["POST"])
@role_required("seller")
def seller_shift_start():
    db = get_db()
    user = get_current_user(db)
    if get_open_seller_shift(db, user["id"]):
        return jsonify({"error": "You already have an open shift."}), 409

    ts = now_iso()
    store_shift = get_open_store_shift(db)

    if store_shift:
        # Join the live shift as a regular seller; first entrant stays supervisor.
        existing = db.execute(
            """SELECT * FROM shift_members
               WHERE shift_id = ? AND user_id = ?""",
            (store_shift["id"], user["id"]),
        ).fetchone()
        if existing and existing["left_at"] is None:
            return jsonify({"error": "You already have an open shift."}), 409
        if existing:
            db.execute(
                """UPDATE shift_members
                   SET left_at = NULL, joined_at = ?, role_on_shift = 'member'
                   WHERE id = ?""",
                (ts, existing["id"]),
            )
        else:
            _add_shift_member(db, store_shift["id"], user["id"], "member", ts)
        db.commit()
        row = db.execute(
            "SELECT * FROM seller_shifts WHERE id = ?",
            (store_shift["id"],),
        ).fetchone()
        shift_data = _shift_payload_for_user(db, row, user["id"])
        supervisor = shift_data.get("supervisor_name") or "the supervisor"
        return jsonify({
            "has_open_shift": True,
            "can_close": False,
            "my_role_on_shift": "member",
            "joined": True,
            "shift": shift_data,
            "message": f"Joined the open shift led by {supervisor}. You can sell now.",
        }), 201

    cur = db.execute(
        """INSERT INTO seller_shifts
           (user_id, status, opened_at, opening_float)
           VALUES (?, 'open', ?, 0)""",
        (user["id"], ts),
    )
    shift_id = cur.lastrowid
    _add_shift_member(db, shift_id, user["id"], "supervisor", ts)
    db.commit()
    row = db.execute(
        "SELECT * FROM seller_shifts WHERE id = ?",
        (shift_id,),
    ).fetchone()
    shift_data = _shift_payload_for_user(db, row, user["id"])
    return jsonify({
        "has_open_shift": True,
        "can_close": True,
        "my_role_on_shift": "supervisor",
        "joined": False,
        "shift": shift_data,
        "message": "Shift started. You are the shift supervisor and can close & reconcile when done.",
    }), 201


def _collect_shift_admin_recipients(db):
    admins, _sellers = report_recipients(db)
    emails = [admin["email"] for admin in admins]
    emails.extend(extra_report_emails())
    seen = set()
    unique = []
    for email in emails:
        key = email.lower()
        if email and key not in seen:
            seen.add(key)
            unique.append(email)
    return unique


def _dispatch_shift_close_email(recipients, shift_data, seller_name):
    if not recipients:
        return

    def _worker():
        try:
            status = (shift_data.get("status_label") or "balanced").title()
            subject = f"Shift closed — {seller_name} ({status})"
            html = render_shift_close_html(shift_data, seller_name)
            text = render_shift_close_text(shift_data, seller_name)
            send_email(recipients, subject, html, text)
        except Exception as exc:  # noqa: BLE001 — email must never break shift close
            app.logger.warning("Shift close email failed: %s", exc)

    threading.Thread(target=_worker, daemon=True).start()


@app.route("/api/seller/shift/close", methods=["POST"])
@role_required("seller")
def seller_shift_close():
    data = request.get_json(silent=True) or {}
    cash_notes, error = _parse_cash_notes(data)
    if error:
        return jsonify({"error": error}), 400

    counted_momo, error = _parse_counted_amount(data, "counted_momo", "MoMo")
    if error:
        return jsonify({"error": error}), 400
    counted_visa, error = _parse_counted_amount(data, "counted_visa", "Visa")
    if error:
        return jsonify({"error": error}), 400

    concerns = (data.get("concerns") or "").strip()[:2000] or None
    report_low_stock = (data.get("report_low_stock") or "").strip()[:2000] or None
    report_issues = (data.get("report_issues") or "").strip()[:2000] or None
    report_wishes = (data.get("report_wishes") or "").strip()[:2000] or None

    counted_cash = _cash_total_from_notes(cash_notes)

    db = get_db()
    user = get_current_user(db)
    shift = get_open_seller_shift(db, user["id"])
    if not shift:
        return jsonify({"error": "No open shift to close. Start or join a shift first."}), 400

    membership = get_shift_membership(db, shift["id"], user["id"])
    if not membership or membership["role_on_shift"] != "supervisor":
        supervisor_name = None
        members = _list_shift_members(db, shift["id"])
        for member in members:
            if member["role_on_shift"] == "supervisor" and member["active"]:
                supervisor_name = member["display_name"]
                break
        led_by = f" led by {supervisor_name}" if supervisor_name else ""
        return jsonify({
            "error": (
                f"Only the shift supervisor{led_by} can close and reconcile. "
                "Keep selling — they will balance the till."
            )
        }), 403

    sales = _seller_sales_for_shift(db, shift["id"])
    expected_cash = sales["cash_sales"]
    expected_momo = sales["momo_sales"]
    expected_visa = sales["visa_sales"]
    cash_variance = round(counted_cash - expected_cash, 2)
    momo_variance = round(counted_momo - expected_momo, 2)
    visa_variance = round(counted_visa - expected_visa, 2)
    ts = now_iso()

    db.execute(
        """UPDATE seller_shifts SET
           status = 'closed',
           closed_at = ?,
           counted_cash = ?,
           expected_cash = ?,
           variance = ?,
           counted_momo = ?,
           expected_momo = ?,
           momo_variance = ?,
           counted_visa = ?,
           expected_visa = ?,
           visa_variance = ?,
           total_sales = ?,
           cash_sales = ?,
           momo_sales = ?,
           visa_sales = ?,
           units_sold = ?,
           sale_count = ?,
           cash_notes_5000 = ?,
           cash_notes_2000 = ?,
           cash_notes_1000 = ?,
           cash_notes_500 = ?,
           cash_notes_100 = ?,
           cash_notes_50 = ?,
           concerns = ?,
           report_low_stock = ?,
           report_issues = ?,
           report_wishes = ?
           WHERE id = ?""",
        (
            ts,
            counted_cash,
            expected_cash,
            cash_variance,
            counted_momo,
            expected_momo,
            momo_variance,
            counted_visa,
            expected_visa,
            visa_variance,
            sales["total_sales"],
            sales["cash_sales"],
            sales["momo_sales"],
            sales["visa_sales"],
            sales["units_sold"],
            sales["sale_count"],
            cash_notes[5000],
            cash_notes[2000],
            cash_notes[1000],
            cash_notes[500],
            cash_notes[100],
            cash_notes[50],
            concerns,
            report_low_stock,
            report_issues,
            report_wishes,
            shift["id"],
        ),
    )
    db.execute(
        """UPDATE shift_members SET left_at = ?
           WHERE shift_id = ? AND left_at IS NULL""",
        (ts, shift["id"]),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM seller_shifts WHERE id = ?",
        (shift["id"],),
    ).fetchone()
    closed = _shift_payload_for_user(db, row, user["id"], include_close=True)
    closed["sales"] = _shift_sales_for_response(db, row["id"])
    message = _shift_close_message(row)

    seller_name = user["display_name"] if "display_name" in user.keys() else "Seller"
    member_names = [
        m["display_name"]
        for m in closed.get("members") or []
        if m["role_on_shift"] != "supervisor"
    ]
    if member_names:
        seller_name = f"{seller_name} (+ {', '.join(member_names)})"

    recipients = _collect_shift_admin_recipients(db)
    _dispatch_shift_close_email(recipients, closed, seller_name)

    return jsonify({
        "has_open_shift": False,
        "can_close": False,
        "my_role_on_shift": None,
        "shift": closed,
        "message": message,
    })


@app.route("/api/restock", methods=["POST"])
@role_required("admin", "supervisor", "stock_manager")
def restock_product():
    data = request.get_json(silent=True) or {}
    product_id = data.get("product_id")

    try:
        quantity = int(data.get("quantity", 0))
        if quantity <= 0:
            return jsonify({"error": "Quantity must be greater than zero"}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid quantity"}), 400

    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found"}), 404

    if category_uses_cups(db, row["category"]):
        return jsonify({
            "error": "Cup-based products use shared cup inventory. Restock cups instead."
        }), 400

    ts = now_iso()
    unit_price = float(data.get("unit_price", row["price"]))
    new_qty = row["quantity"] + quantity

    db.execute("UPDATE products SET quantity=?, updated_at=? WHERE id=?",
               (new_qty, ts, product_id))
    db.execute(
        """INSERT INTO transactions
           (product_id, type, quantity, unit_price, total_amount, notes, created_at)
           VALUES (?, 'restock', ?, ?, ?, ?, ?)""",
        (product_id, quantity, unit_price, round(unit_price * quantity, 2),
         (data.get("notes") or "Stock replenishment").strip(), ts),
    )
    db.commit()

    updated = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    category_cup_map = get_category_cup_map(db)
    cup_inventory = get_cup_inventory(db)
    return jsonify(row_to_product(updated, category_cup_map, cup_inventory))


@app.route("/api/adjust", methods=["POST"])
@role_required("admin", "stock_manager")
def adjust_stock():
    data = request.get_json(silent=True) or {}
    product_id = data.get("product_id")

    try:
        new_quantity = int(data.get("new_quantity", -1))
        if new_quantity < 0:
            return jsonify({"error": "Quantity cannot be negative"}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid quantity"}), 400

    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return jsonify({"error": "Product not found"}), 404

    if category_uses_cups(db, row["category"]):
        return jsonify({
            "error": "Cup-based products use shared cup inventory. Adjust cups instead."
        }), 400

    diff = new_quantity - row["quantity"]
    if diff == 0:
        category_cup_map = get_category_cup_map(db)
        cup_inventory = get_cup_inventory(db)
        return jsonify(row_to_product(row, category_cup_map, cup_inventory))

    ts = now_iso()
    db.execute("UPDATE products SET quantity=?, updated_at=? WHERE id=?",
               (new_quantity, ts, product_id))
    db.execute(
        """INSERT INTO transactions
           (product_id, type, quantity, unit_price, total_amount, notes, created_at)
           VALUES (?, 'adjustment', ?, ?, 0, ?, ?)""",
        (product_id, diff, float(row["price"]),
         f"Adjusted from {row['quantity']} to {new_quantity}. "
         + ((data.get("notes") or "").strip() or "Manual stock correction"), ts),
    )
    db.commit()

    updated = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    category_cup_map = get_category_cup_map(db)
    cup_inventory = get_cup_inventory(db)
    return jsonify(row_to_product(updated, category_cup_map, cup_inventory))


# ── Cup inventory API ────────────────────────────────────────────────────────

@app.route("/api/cups", methods=["GET"])
@login_required
def get_cups():
    return jsonify(row_to_cup_inventory(get_cup_inventory(get_db())))


@app.route("/api/cups/restock", methods=["POST"])
@login_required
def restock_cups():
    data = request.get_json(silent=True) or {}
    try:
        quantity = int(data.get("quantity", 0))
        if quantity <= 0:
            return jsonify({"error": "Quantity must be greater than zero"}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid quantity"}), 400

    db = get_db()
    cup_inv = get_cup_inventory(db)
    ts = now_iso()
    new_qty = cup_inv["quantity"] + quantity

    db.execute(
        "UPDATE cup_inventory SET quantity=?, updated_at=? WHERE id=1",
        (new_qty, ts),
    )
    db.execute(
        """INSERT INTO cup_transactions (type, quantity, notes, created_at)
           VALUES ('restock', ?, ?, ?)""",
        (quantity, (data.get("notes") or "Cup replenishment").strip(), ts),
    )
    db.commit()
    return jsonify(row_to_cup_inventory(get_cup_inventory(db)))


@app.route("/api/cups/adjust", methods=["POST"])
@role_required("admin", "stock_manager")
def adjust_cups():
    data = request.get_json(silent=True) or {}
    try:
        new_quantity = int(data.get("new_quantity", -1))
        if new_quantity < 0:
            return jsonify({"error": "Quantity cannot be negative"}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid quantity"}), 400

    db = get_db()
    cup_inv = get_cup_inventory(db)
    diff = new_quantity - cup_inv["quantity"]
    if diff == 0:
        return jsonify(row_to_cup_inventory(cup_inv))

    ts = now_iso()
    db.execute(
        "UPDATE cup_inventory SET quantity=?, updated_at=? WHERE id=1",
        (new_quantity, ts),
    )
    db.execute(
        """INSERT INTO cup_transactions (type, quantity, notes, created_at)
           VALUES ('adjustment', ?, ?, ?)""",
        (diff, (data.get("notes") or "Cup stock correction").strip(), ts),
    )
    db.commit()
    return jsonify(row_to_cup_inventory(get_cup_inventory(db)))


# ── Transactions & Dashboard API ─────────────────────────────────────────────

@app.route("/api/transactions", methods=["GET"])
@role_required("admin", "supervisor", "stock_manager")
def list_transactions():
    db = get_db()

    limit = min(int(request.args.get("limit", 50)), 500)
    tx_type = request.args.get("type", "").strip()
    date_from = request.args.get("from", "").strip()
    date_to = request.args.get("to", "").strip()
    user_id = request.args.get("user_id", "").strip()
    category = request.args.get("category", "").strip()

    query = """
        SELECT t.*, p.name AS product_name, p.category,
               u.display_name AS seller_name
        FROM transactions t
        JOIN products p ON p.id = t.product_id
        LEFT JOIN users u ON u.id = t.user_id
        WHERE 1=1
    """
    params = []
    if tx_type:
        query += " AND t.type = ?"
        params.append(tx_type)
    if category:
        query += " AND p.category = ?"
        params.append(category)
    if date_from:
        query += " AND substr(t.created_at, 1, 10) >= ?"
        params.append(date_from)
    if date_to:
        query += " AND substr(t.created_at, 1, 10) <= ?"
        params.append(date_to)
    user_clause, user_params = _sale_user_clause(user_id, "t")
    query += user_clause
    params.extend(user_params)
    query += " ORDER BY t.created_at DESC LIMIT ?"
    params.append(limit)

    rows = db.execute(query, params).fetchall()
    return jsonify([row_to_transaction(r) for r in rows])


@app.route("/api/sellers", methods=["GET"])
@role_required("admin", "supervisor", "stock_manager")
def list_sellers():
    rows = get_db().execute(
        """SELECT id, display_name, username
           FROM users
           WHERE is_active = 1
           ORDER BY display_name COLLATE NOCASE ASC, username COLLATE NOCASE ASC"""
    ).fetchall()
    return jsonify([
        {
            "id": r["id"],
            "display_name": r["display_name"],
            "username": r["username"],
        }
        for r in rows
    ])


@app.route("/api/sales/dates", methods=["GET"])
@role_required("admin", "supervisor", "stock_manager")
def sales_dates():
    db = get_db()
    rows = db.execute(
        f"""SELECT substr(created_at, 1, 10) AS sale_date,
                  COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units,
                  COUNT(*) AS transactions
           FROM transactions
           WHERE type = 'sale'{_not_voided_clause()}
           GROUP BY sale_date
           ORDER BY sale_date DESC"""
    ).fetchall()
    return jsonify([
        {
            "date": r["sale_date"],
            "revenue": round(r["revenue"], 2),
            "units": r["units"],
            "transactions": r["transactions"],
        }
        for r in rows
    ])


@app.route("/api/sales/report", methods=["GET"])
@role_required("admin", "supervisor", "stock_manager")
def sales_report():
    db = get_db()

    preset = request.args.get("preset", "").strip()
    date_from = request.args.get("from", "").strip()
    date_to = request.args.get("to", "").strip()
    user_id = request.args.get("user_id", "").strip()

    if preset == "today":
        date_from = date_to = today_kigali()
    elif preset == "week":
        date_from, date_to = week_range_kigali()
    elif preset == "month":
        date_from, date_to = month_range_kigali()
    elif not date_from or not date_to:
        return jsonify({"error": "Provide a preset or both from and to dates"}), 400

    start = parse_date(date_from)
    end = parse_date(date_to)
    if not start or not end or start > end:
        return jsonify({"error": "Invalid date range"}), 400

    user_clause, user_params = _sale_user_clause(user_id, "t")
    sales_rows = db.execute(
        f"""SELECT t.*, p.name AS product_name, p.category,
                   u.display_name AS seller_name
           FROM transactions t
           JOIN products p ON p.id = t.product_id
           LEFT JOIN users u ON u.id = t.user_id
           WHERE t.type = 'sale'{_not_voided_clause("t")}
             AND substr(t.created_at, 1, 10) >= ?
             AND substr(t.created_at, 1, 10) <= ?{user_clause}
           ORDER BY t.created_at DESC""",
        (date_from, date_to, *user_params),
    ).fetchall()

    summary = _sales_summary(db, date_from, date_to, user_id)
    daily = _daily_sales_breakdown(db, date_from, date_to, user_id)
    payments = _payment_breakdown(db, date_from, date_to, user_id)
    categories = _category_breakdown(db, date_from, date_to, user_id)

    return jsonify({
        "from": date_from,
        "to": date_to,
        "preset": preset or "custom",
        "user_id": _parse_user_id_filter(user_id),
        "summary": summary,
        "daily_breakdown": daily,
        "payment_breakdown": payments,
        "category_breakdown": categories,
        "sales": [row_to_transaction(r) for r in sales_rows],
    })


def _shift_report_row(db, row):
    data = {
        "id": row["id"],
        "seller_id": row["user_id"],
        "seller_name": row["seller_name"],
        "status": row["status"],
        "opened_at": row["opened_at"],
        "closed_at": row["closed_at"],
    }
    data.update(_shift_report_fields(row))
    members = _list_shift_members(db, row["id"])
    data["members"] = members
    data["supervisor_name"] = next(
        (m["display_name"] for m in members if m["role_on_shift"] == "supervisor"),
        row["seller_name"],
    )
    if row["status"] == "closed":
        cash_variance = round(row["variance"] or 0, 2)
        momo_variance = round(row["momo_variance"] or 0, 2)
        visa_variance = round(row["visa_variance"] or 0, 2)
        data.update({
            "counted_cash": round(row["counted_cash"] or 0, 2),
            "expected_cash": round(row["expected_cash"] or 0, 2),
            "variance": cash_variance,
            "counted_momo": round(row["counted_momo"] or 0, 2),
            "expected_momo": round(row["expected_momo"] or row["momo_sales"] or 0, 2),
            "momo_variance": momo_variance,
            "counted_visa": round(row["counted_visa"] or 0, 2),
            "expected_visa": round(row["expected_visa"] or row["visa_sales"] or 0, 2),
            "visa_variance": visa_variance,
            "total_sales": round(row["total_sales"] or 0, 2),
            "cash_sales": round(row["cash_sales"] or 0, 2),
            "momo_sales": round(row["momo_sales"] or 0, 2),
            "visa_sales": round(row["visa_sales"] or 0, 2),
            "units_sold": row["units_sold"] or 0,
            "sale_count": row["sale_count"] or 0,
            "status_label": _shift_overall_status(
                cash_variance, momo_variance, visa_variance
            ),
            "cash_notes": _cash_notes_from_row(row),
        })
    else:
        data.update(_seller_sales_for_shift(db, row["id"]))
        data["counted_cash"] = None
        data["expected_cash"] = None
        data["variance"] = None
        data["status_label"] = None
    return data


def _shifts_summary(shifts):
    total_sales = sum(s["total_sales"] for s in shifts)
    cash_sales = sum(s["cash_sales"] for s in shifts)
    momo_sales = sum(s["momo_sales"] for s in shifts)
    visa_sales = sum(s["visa_sales"] for s in shifts)
    units_sold = sum(s["units_sold"] for s in shifts)
    sale_count = sum(s["sale_count"] for s in shifts)
    closed = [s for s in shifts if s["status"] == "closed"]
    open_count = sum(1 for s in shifts if s["status"] == "open")
    total_variance = sum(s["variance"] or 0 for s in closed)
    return {
        "shift_count": len(shifts),
        "open_shifts": open_count,
        "closed_shifts": len(closed),
        "total_sales": round(total_sales, 2),
        "cash_sales": round(cash_sales, 2),
        "momo_sales": round(momo_sales, 2),
        "visa_sales": round(visa_sales, 2),
        "units_sold": units_sold,
        "sale_count": sale_count,
        "total_variance": round(total_variance, 2),
    }


def _shifts_payment_breakdown(summary):
    return [
        {
            "method": "momo",
            "label": "MoMo",
            "revenue": summary["momo_sales"],
            "checkouts": summary["sale_count"],
        },
        {
            "method": "cash",
            "label": "Cash",
            "revenue": summary["cash_sales"],
            "checkouts": summary["sale_count"],
        },
        {
            "method": "visa",
            "label": "Visa",
            "revenue": summary["visa_sales"],
            "checkouts": summary["sale_count"],
        },
    ]


def _shifts_date_range_params():
    preset = request.args.get("preset", "").strip()
    date_from = request.args.get("from", "").strip()
    date_to = request.args.get("to", "").strip()

    if preset == "today":
        date_from = date_to = today_kigali()
    elif preset == "week":
        date_from, date_to = week_range_kigali()
    elif preset == "month":
        date_from, date_to = month_range_kigali()
    elif not date_from or not date_to:
        return None, None, None, ("Provide a preset or both from and to dates", 400)

    start = parse_date(date_from)
    end = parse_date(date_to)
    if not start or not end or start > end:
        return None, None, None, ("Invalid date range", 400)

    return date_from, date_to, preset, None


@app.route("/api/shifts/report", methods=["GET"])
@role_required("admin", "supervisor", "stock_manager")
def shifts_report():
    db = get_db()

    date_from, date_to, preset, error = _shifts_date_range_params()
    if error:
        return jsonify({"error": error[0]}), error[1]

    user_id = request.args.get("user_id", "").strip()
    user_clause = ""
    user_params = []
    uid = _parse_user_id_filter(user_id)
    if uid is not None:
        user_clause = (
            " AND (s.user_id = ? OR EXISTS ("
            "SELECT 1 FROM shift_members m "
            "WHERE m.shift_id = s.id AND m.user_id = ?))"
        )
        user_params = [uid, uid]

    rows = db.execute(
        f"""SELECT s.*, u.display_name AS seller_name
            FROM seller_shifts s
            JOIN users u ON u.id = s.user_id
            WHERE (
                substr(s.opened_at, 1, 10) >= ? AND substr(s.opened_at, 1, 10) <= ?
                OR (s.closed_at IS NOT NULL
                    AND substr(s.closed_at, 1, 10) >= ? AND substr(s.closed_at, 1, 10) <= ?)
            ){user_clause}
            ORDER BY s.opened_at DESC""",
        (date_from, date_to, date_from, date_to, *user_params),
    ).fetchall()

    shifts = [_shift_report_row(db, row) for row in rows]
    summary = _shifts_summary(shifts)

    return jsonify({
        "from": date_from,
        "to": date_to,
        "preset": preset or "custom",
        "user_id": uid,
        "summary": summary,
        "payment_breakdown": _shifts_payment_breakdown(summary),
        "shifts": shifts,
    })


@app.route("/api/shifts/<int:shift_id>", methods=["GET"])
@role_required("admin", "supervisor", "stock_manager")
def shift_detail(shift_id):
    db = get_db()

    row = db.execute(
        """SELECT s.*, u.display_name AS seller_name
           FROM seller_shifts s
           JOIN users u ON u.id = s.user_id
           WHERE s.id = ?""",
        (shift_id,),
    ).fetchone()
    if not row:
        return jsonify({"error": "Shift not found"}), 404

    data = _shift_report_row(db, row)
    data["sales"] = _shift_sales_for_response(db, shift_id)
    return jsonify(data)


@app.route("/api/dashboard", methods=["GET"])
@role_required("admin", "supervisor", "stock_manager")
def dashboard_stats():
    db = get_db()
    category_cup_map = get_category_cup_map(db)
    cup_inventory = get_cup_inventory(db)

    products = db.execute("SELECT * FROM products").fetchall()
    total_products = len(products)
    total_stock = sum(
        p["quantity"] for p in products if not category_cup_map.get(p["category"], False)
    )
    total_stock += cup_inventory["quantity"]
    inventory_value = sum(
        p["price"] * p["quantity"]
        for p in products
        if not category_cup_map.get(p["category"], False)
    )

    enriched = [
        row_to_product(p, category_cup_map, cup_inventory) for p in products
    ]
    low_stock = [
        p for p in enriched
        if not p["uses_cup_stock"] and p["stock_status"] in ("low", "out")
    ]
    out_of_stock = sum(
        1 for p in enriched if not p["uses_cup_stock"] and p["stock_status"] == "out"
    )
    cup_stock = row_to_cup_inventory(cup_inventory)

    today = today_kigali()
    week_from, week_to = week_range_kigali()
    month_from, month_to = month_range_kigali()

    today_date_obj = now_kigali().date()
    yesterday_str = (today_date_obj - timedelta(days=1)).strftime("%Y-%m-%d")

    this_week_start = today_date_obj - timedelta(days=today_date_obj.weekday())
    prev_week_start = this_week_start - timedelta(weeks=1)
    prev_week_end = this_week_start - timedelta(days=1)
    prev_week_from = prev_week_start.strftime("%Y-%m-%d")
    prev_week_to = prev_week_end.strftime("%Y-%m-%d")

    this_month_start = today_date_obj.replace(day=1)
    prev_month_end = this_month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev_month_from = prev_month_start.strftime("%Y-%m-%d")
    prev_month_to = prev_month_end.strftime("%Y-%m-%d")

    sales_today = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units
           FROM transactions WHERE type='sale'{_not_voided_clause()} AND substr(created_at, 1, 10) = ?""",
        (today,),
    ).fetchone()

    sales_week = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units
           FROM transactions
           WHERE type='sale'{_not_voided_clause()}
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?""",
        (week_from, week_to),
    ).fetchone()

    sales_month = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units
           FROM transactions
           WHERE type='sale'{_not_voided_clause()}
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?""",
        (month_from, month_to),
    ).fetchone()

    sales_yesterday = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units
           FROM transactions WHERE type='sale'{_not_voided_clause()} AND substr(created_at, 1, 10) = ?""",
        (yesterday_str,),
    ).fetchone()

    sales_prev_week = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units
           FROM transactions
           WHERE type='sale'{_not_voided_clause()}
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?""",
        (prev_week_from, prev_week_to),
    ).fetchone()

    sales_prev_month = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units
           FROM transactions
           WHERE type='sale'{_not_voided_clause()}
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?""",
        (prev_month_from, prev_month_to),
    ).fetchone()

    seven_days_ago = (today_date_obj - timedelta(days=6)).strftime("%Y-%m-%d")
    daily_rows = db.execute(
        f"""SELECT substr(created_at, 1, 10) AS day,
                  COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(quantity), 0) AS units
           FROM transactions
           WHERE type='sale'{_not_voided_clause()}
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?
           GROUP BY day
           ORDER BY day ASC""",
        (seven_days_ago, today),
    ).fetchall()

    daily_map = {
        r["day"]: {"revenue": round(r["revenue"], 2), "units": r["units"]}
        for r in daily_rows
    }
    daily_revenue_7d = []
    for i in range(6, -1, -1):
        date_str = (today_date_obj - timedelta(days=i)).strftime("%Y-%m-%d")
        entry = daily_map.get(date_str, {"revenue": 0.0, "units": 0})
        daily_revenue_7d.append({"date": date_str, **entry})

    sales_all = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COUNT(*) AS count
           FROM transactions WHERE type='sale'{_not_voided_clause()}"""
    ).fetchone()

    category_stats = db.execute(
        """SELECT p.category,
                  COUNT(*) AS product_count,
                  SUM(CASE WHEN c.uses_cup_stock = 1 THEN 0 ELSE p.quantity END) AS total_qty,
                  SUM(CASE WHEN c.uses_cup_stock = 1 THEN 0 ELSE p.price * p.quantity END) AS value
           FROM products p
           LEFT JOIN categories c ON c.name = p.category
           GROUP BY p.category ORDER BY value DESC"""
    ).fetchall()

    sales_by_category_today = db.execute(
        f"""SELECT p.category,
                  COALESCE(SUM(t.total_amount), 0) AS revenue,
                  COALESCE(SUM(t.quantity), 0) AS units,
                  COUNT(t.id) AS transactions
           FROM transactions t
           JOIN products p ON p.id = t.product_id
           WHERE t.type = 'sale'{_not_voided_clause("t")}
             AND substr(t.created_at, 1, 10) = ?
           GROUP BY p.category
           ORDER BY revenue DESC, p.category COLLATE NOCASE ASC""",
        (today,),
    ).fetchall()

    top_products = db.execute(
        f"""SELECT p.id, p.name, p.category, p.price,
                  COALESCE(SUM(t.quantity), 0) AS units_sold,
                  COALESCE(SUM(t.total_amount), 0) AS revenue
           FROM products p
           LEFT JOIN transactions t ON t.product_id = p.id AND t.type = 'sale' AND t.voided_at IS NULL
           GROUP BY p.id
           ORDER BY units_sold DESC
           LIMIT 5"""
    ).fetchall()

    recent = db.execute(
        """SELECT t.*, p.name AS product_name, p.category,
                  u.display_name AS seller_name
           FROM transactions t
           JOIN products p ON p.id = t.product_id
           LEFT JOIN users u ON u.id = t.user_id
           ORDER BY t.created_at DESC LIMIT 8"""
    ).fetchall()

    return jsonify({
        "total_products": total_products,
        "total_stock_units": total_stock,
        "inventory_value": round(inventory_value, 2),
        "low_stock_count": len(low_stock) + (1 if cup_stock["stock_status"] in ("low", "out") else 0),
        "out_of_stock_count": out_of_stock + (1 if cup_stock["stock_status"] == "out" else 0),
        "low_stock_items": low_stock[:8],
        "cup_inventory": cup_stock,
        "revenue_today": round(sales_today["revenue"], 2),
        "units_sold_today": sales_today["units"],
        "revenue_yesterday": round(sales_yesterday["revenue"], 2),
        "units_sold_yesterday": sales_yesterday["units"],
        "revenue_week": round(sales_week["revenue"], 2),
        "units_sold_week": sales_week["units"],
        "revenue_prev_week": round(sales_prev_week["revenue"], 2),
        "units_sold_prev_week": sales_prev_week["units"],
        "revenue_month": round(sales_month["revenue"], 2),
        "units_sold_month": sales_month["units"],
        "revenue_prev_month": round(sales_prev_month["revenue"], 2),
        "units_sold_prev_month": sales_prev_month["units"],
        "daily_revenue_7d": daily_revenue_7d,
        "today_date": today,
        "total_revenue": round(sales_all["revenue"], 2),
        "total_sales_count": sales_all["count"],
        "categories": [
            {
                "name": c["category"],
                "product_count": c["product_count"],
                "total_qty": c["total_qty"],
                "value": round(c["value"], 2),
            }
            for c in category_stats
        ],
        "sales_by_category_today": [
            {
                "name": c["category"],
                "revenue": round(c["revenue"], 2),
                "units": c["units"],
                "transactions": c["transactions"],
            }
            for c in sales_by_category_today
        ],
        "top_products": [
            {
                "id": t["id"],
                "name": t["name"],
                "category": t["category"],
                "price": round(t["price"], 2),
                "units_sold": t["units_sold"],
                "revenue": round(t["revenue"], 2),
            }
            for t in top_products
        ],
        "recent_transactions": [row_to_transaction(r) for r in recent],
    })


@app.route("/api/categories", methods=["GET"])
@login_required
def list_categories():
    rows = get_db().execute(
        """SELECT c.id, c.name, c.sort_order, c.created_at, c.uses_cup_stock,
                  COUNT(p.id) AS product_count
           FROM categories c
           LEFT JOIN products p ON p.category = c.name
           GROUP BY c.id
           ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC"""
    ).fetchall()
    return jsonify([row_to_category(r) for r in rows])


@app.route("/api/admin/categories", methods=["POST"])
@admin_required
def admin_create_category():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Category name is required"}), 400
    if len(name) > 60:
        return jsonify({"error": "Category name is too long"}), 400

    db = get_db()
    existing = db.execute(
        "SELECT id FROM categories WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if existing:
        return jsonify({"error": "Category already exists"}), 409

    max_order = db.execute("SELECT COALESCE(MAX(sort_order), -1) AS n FROM categories").fetchone()["n"]
    uses_cup_stock = 1 if data.get("uses_cup_stock") else 0
    ts = now_iso()
    cur = db.execute(
        "INSERT INTO categories (name, sort_order, uses_cup_stock, created_at) VALUES (?, ?, ?, ?)",
        (name, max_order + 1, uses_cup_stock, ts),
    )
    db.commit()
    row = db.execute(
        """SELECT c.id, c.name, c.sort_order, c.created_at, c.uses_cup_stock, 0 AS product_count
           FROM categories c WHERE c.id = ?""",
        (cur.lastrowid,),
    ).fetchone()
    return jsonify(row_to_category(row)), 201


@app.route("/api/admin/categories/<int:category_id>", methods=["PUT"])
@admin_required
def admin_update_category(category_id):
    db = get_db()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
    if not row:
        return jsonify({"error": "Category not found"}), 404

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Category name is required"}), 400
    if len(name) > 60:
        return jsonify({"error": "Category name is too long"}), 400

    duplicate = db.execute(
        "SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id != ?",
        (name, category_id),
    ).fetchone()
    if duplicate:
        return jsonify({"error": "Category already exists"}), 409

    old_name = row["name"]
    uses_cup_stock = (
        1 if data.get("uses_cup_stock", row["uses_cup_stock"]) else 0
    )
    if is_default_category(old_name):
        default = next(c for c in DEFAULT_CATEGORIES if c["name"].casefold() == old_name.casefold())
        uses_cup_stock = default["uses_cup_stock"]
    if name != old_name:
        db.execute("UPDATE products SET category = ? WHERE category = ?", (name, old_name))
    db.execute(
        "UPDATE categories SET name = ?, uses_cup_stock = ? WHERE id = ?",
        (name, uses_cup_stock, category_id),
    )
    if uses_cup_stock:
        db.execute(
            "UPDATE products SET quantity = 0 WHERE category = ?",
            (name,),
        )
    db.commit()

    updated = db.execute(
        """SELECT c.id, c.name, c.sort_order, c.created_at, c.uses_cup_stock,
                  COUNT(p.id) AS product_count
           FROM categories c
           LEFT JOIN products p ON p.category = c.name
           WHERE c.id = ?
           GROUP BY c.id""",
        (category_id,),
    ).fetchone()
    return jsonify(row_to_category(updated))


@app.route("/api/admin/categories/<int:category_id>", methods=["DELETE"])
@admin_required
def admin_delete_category(category_id):
    db = get_db()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
    if not row:
        return jsonify({"error": "Category not found"}), 404

    if is_default_category(row["name"]):
        return jsonify({"error": "Default categories cannot be deleted"}), 400

    product_count = db.execute(
        "SELECT COUNT(*) AS n FROM products WHERE category = ?", (row["name"],)
    ).fetchone()["n"]
    if product_count > 0:
        return jsonify({
            "error": f"Cannot delete — {product_count} product(s) use this category"
        }), 400

    db.execute("DELETE FROM categories WHERE id = ?", (category_id,))
    db.commit()
    return jsonify({"message": "Category deleted"})


with app.app_context():
    init_db()


if __name__ == "__main__":
    app.run(debug=True, port=5000)
