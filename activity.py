"""Business-scoped activity / audit logging for Brew & Scoop."""

import json

from flask import session


def init_activity_logs_table(db):
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER,
            user_id INTEGER,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_id TEXT,
            details TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_activity_logs_business_created
            ON activity_logs(business_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created
            ON activity_logs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activity_logs_action
            ON activity_logs(action);
        """
    )


def row_to_activity_log(row):
    keys = row.keys()
    details = row["details"] if "details" in keys else None
    parsed = None
    if details:
        try:
            parsed = json.loads(details)
        except (TypeError, ValueError):
            parsed = {"raw": details}
    return {
        "id": row["id"],
        "business_id": row["business_id"] if "business_id" in keys else None,
        "business_name": row["business_name"] if "business_name" in keys else None,
        "user_id": row["user_id"] if "user_id" in keys else None,
        "user_name": row["user_name"] if "user_name" in keys else None,
        "action": row["action"],
        "entity_type": row["entity_type"] if "entity_type" in keys else None,
        "entity_id": row["entity_id"] if "entity_id" in keys else None,
        "details": parsed,
        "created_at": row["created_at"],
    }


def log_activity(
    db,
    *,
    action,
    business_id=None,
    user_id=None,
    entity_type=None,
    entity_id=None,
    details=None,
    created_at=None,
):
    """Insert an activity log row. Never raises to callers — logging must not break flows."""
    try:
        if business_id is None:
            try:
                value = session.get("business_id")
                business_id = int(value) if value is not None else None
            except (RuntimeError, TypeError, ValueError):
                business_id = None
        if user_id is None:
            try:
                value = session.get("user_id")
                user_id = int(value) if value is not None else None
            except (RuntimeError, TypeError, ValueError):
                user_id = None

        if created_at is None:
            from app import now_iso

            created_at = now_iso()

        details_json = None
        if details is not None:
            if isinstance(details, str):
                details_json = details
            else:
                details_json = json.dumps(details, ensure_ascii=False, default=str)

        db.execute(
            """INSERT INTO activity_logs
               (business_id, user_id, action, entity_type, entity_id, details, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                business_id,
                user_id,
                action,
                entity_type,
                str(entity_id) if entity_id is not None else None,
                details_json,
                created_at,
            ),
        )
    except Exception:
        # Audit logging must never break the primary operation.
        pass


def list_activity_logs(
    db,
    *,
    business_id=None,
    user_id=None,
    action=None,
    date_from=None,
    date_to=None,
    limit=100,
    offset=0,
):
    query = """
        SELECT a.*,
               u.display_name AS user_name,
               b.name AS business_name
        FROM activity_logs a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN businesses b ON b.id = a.business_id
        WHERE 1=1
    """
    params = []
    if business_id is not None:
        query += " AND a.business_id = ?"
        params.append(business_id)
    if user_id is not None:
        query += " AND a.user_id = ?"
        params.append(user_id)
    if action:
        query += " AND a.action = ?"
        params.append(action)
    if date_from:
        query += " AND substr(a.created_at, 1, 10) >= ?"
        params.append(date_from)
    if date_to:
        query += " AND substr(a.created_at, 1, 10) <= ?"
        params.append(date_to)
    query += " ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    rows = db.execute(query, params).fetchall()
    return [row_to_activity_log(r) for r in rows]


ACTION_LABELS = {
    "login": "Signed in",
    "logout": "Signed out",
    "switch_business": "Switched business",
    "product.create": "Created product",
    "product.update": "Updated product",
    "product.delete": "Deleted product",
    "restock": "Restocked product",
    "stock.adjust": "Adjusted stock",
    "sale.checkout": "Completed sale",
    "sale.void": "Voided sale",
    "sale.settle_credit": "Settled credit sale",
    "cups.restock": "Restocked cups",
    "cups.adjust": "Adjusted cups",
    "user.create": "Created user",
    "user.update": "Updated user",
    "user.delete": "Removed user",
    "category.create": "Created category",
    "category.update": "Updated category",
    "category.delete": "Deleted category",
    "shift.start": "Started shift",
    "shift.join": "Joined shift",
    "shift.close": "Closed shift",
    "business.create": "Created business",
    "business.update": "Updated business",
}


def action_label(action):
    return ACTION_LABELS.get(action, action.replace(".", " ").replace("_", " ").title())
