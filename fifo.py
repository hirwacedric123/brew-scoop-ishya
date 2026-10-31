"""FIFO / FEFO stock lot tracking for products, ingredients, and cups."""

from __future__ import annotations

from datetime import datetime, timedelta

POOL_PRODUCT = "product"
POOL_INGREDIENT = "ingredient"
POOL_CUP = "cup"
VALID_POOLS = (POOL_PRODUCT, POOL_INGREDIENT, POOL_CUP)

LOT_SOURCES = ("restock", "opening", "adjustment", "void_restore")

# FEFO: dated lots soonest-first, then undated by received_at, then id.
_FEFO_ORDER = """
    CASE WHEN expiry_date IS NULL OR expiry_date = '' THEN 1 ELSE 0 END ASC,
    expiry_date ASC,
    received_at ASC,
    id ASC
"""


class InsufficientLotStock(Exception):
    """Raised when open lots cannot cover a requested consume qty."""

    def __init__(self, message, available=0):
        super().__init__(message)
        self.available = available


def _table_columns(db, table):
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def _table_exists(db, name):
    return bool(
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (name,),
        ).fetchone()
    )


def _lot_table(pool):
    if pool == POOL_PRODUCT:
        return "product_lots"
    if pool == POOL_INGREDIENT:
        return "ingredient_lots"
    if pool == POOL_CUP:
        return "cup_lots"
    raise ValueError(f"Unknown pool: {pool}")


def _ref_column(pool):
    if pool == POOL_PRODUCT:
        return "product_id"
    if pool == POOL_INGREDIENT:
        return "ingredient_id"
    return None


def _normalize_expiry(expiry_date):
    if expiry_date is None:
        return None
    text = str(expiry_date).strip()
    if not text:
        return None
    # Accept YYYY-MM-DD or full ISO; store date portion only.
    return text[:10]


def _parse_qty(value, integer=False):
    if integer:
        return int(round(float(value)))
    return float(value)


def migrate_fifo_lots(db, now_iso_fn, category_uses_cups_fn, product_uses_recipe_fn):
    """Create lot tables and seed opening lots from current aggregates once."""
    db.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS product_lots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            received_at TEXT NOT NULL,
            expiry_date TEXT,
            unit_cost REAL NOT NULL DEFAULT 0 CHECK(unit_cost >= 0),
            qty_original INTEGER NOT NULL CHECK(qty_original >= 0),
            qty_remaining INTEGER NOT NULL CHECK(qty_remaining >= 0),
            notes TEXT,
            source TEXT NOT NULL CHECK(source IN ('restock', 'opening', 'adjustment', 'void_restore')),
            created_at TEXT NOT NULL,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ingredient_lots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            ingredient_id INTEGER NOT NULL,
            received_at TEXT NOT NULL,
            expiry_date TEXT,
            unit_cost REAL NOT NULL DEFAULT 0 CHECK(unit_cost >= 0),
            qty_original REAL NOT NULL CHECK(qty_original >= 0),
            qty_remaining REAL NOT NULL CHECK(qty_remaining >= 0),
            notes TEXT,
            source TEXT NOT NULL CHECK(source IN ('restock', 'opening', 'adjustment', 'void_restore')),
            created_at TEXT NOT NULL,
            FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS cup_lots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            received_at TEXT NOT NULL,
            expiry_date TEXT,
            unit_cost REAL NOT NULL DEFAULT 0 CHECK(unit_cost >= 0),
            qty_original INTEGER NOT NULL CHECK(qty_original >= 0),
            qty_remaining INTEGER NOT NULL CHECK(qty_remaining >= 0),
            notes TEXT,
            source TEXT NOT NULL CHECK(source IN ('restock', 'opening', 'adjustment', 'void_restore')),
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS lot_allocations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            pool TEXT NOT NULL CHECK(pool IN ('product', 'ingredient', 'cup')),
            lot_id INTEGER NOT NULL,
            ref_id INTEGER,
            checkout_ref TEXT,
            transaction_id INTEGER,
            ingredient_tx_id INTEGER,
            cup_tx_id INTEGER,
            quantity REAL NOT NULL,
            unit_cost REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_product_lots_open
            ON product_lots(business_id, product_id, expiry_date, received_at);
        CREATE INDEX IF NOT EXISTS idx_ingredient_lots_open
            ON ingredient_lots(business_id, ingredient_id, expiry_date, received_at);
        CREATE INDEX IF NOT EXISTS idx_cup_lots_open
            ON cup_lots(business_id, expiry_date, received_at);
        CREATE INDEX IF NOT EXISTS idx_lot_allocations_checkout
            ON lot_allocations(checkout_ref);
        CREATE INDEX IF NOT EXISTS idx_lot_allocations_pool_lot
            ON lot_allocations(business_id, pool, lot_id);
        """
    )

    # Seed opening lots only once (when no lots exist yet for any pool).
    any_lots = db.execute(
        """SELECT
             (SELECT COUNT(*) FROM product_lots) +
             (SELECT COUNT(*) FROM ingredient_lots) +
             (SELECT COUNT(*) FROM cup_lots) AS n"""
    ).fetchone()["n"]
    if any_lots > 0:
        return

    ts = now_iso_fn()
    products = db.execute("SELECT * FROM products").fetchall()
    for row in products:
        qty = int(row["quantity"] or 0)
        if qty <= 0:
            continue
        if product_uses_recipe_fn(row):
            continue
        try:
            if category_uses_cups_fn(db, row["category"], row["business_id"]):
                continue
        except TypeError:
            if category_uses_cups_fn(db, row["category"]):
                continue
        db.execute(
            """INSERT INTO product_lots
               (business_id, product_id, received_at, expiry_date, unit_cost,
                qty_original, qty_remaining, notes, source, created_at)
               VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'opening', ?)""",
            (
                row["business_id"],
                row["id"],
                ts,
                float(row["cost_price"] or 0),
                qty,
                qty,
                "Opening balance from existing stock",
                ts,
            ),
        )

    if _table_exists(db, "ingredients"):
        for row in db.execute("SELECT * FROM ingredients").fetchall():
            qty = float(row["quantity"] or 0)
            if qty <= 0:
                continue
            db.execute(
                """INSERT INTO ingredient_lots
                   (business_id, ingredient_id, received_at, expiry_date, unit_cost,
                    qty_original, qty_remaining, notes, source, created_at)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'opening', ?)""",
                (
                    row["business_id"],
                    row["id"],
                    ts,
                    float(row["cost_per_unit"] or 0),
                    qty,
                    qty,
                    "Opening balance from existing stock",
                    ts,
                ),
            )

    if _table_exists(db, "cup_inventory"):
        cup_cols = _table_columns(db, "cup_inventory")
        if "business_id" in cup_cols:
            cups = db.execute("SELECT * FROM cup_inventory").fetchall()
        else:
            cups = []
        for row in cups:
            qty = int(row["quantity"] or 0)
            if qty <= 0:
                continue
            db.execute(
                """INSERT INTO cup_lots
                   (business_id, received_at, expiry_date, unit_cost,
                    qty_original, qty_remaining, notes, source, created_at)
                   VALUES (?, ?, NULL, 0, ?, ?, ?, 'opening', ?)""",
                (
                    row["business_id"],
                    ts,
                    qty,
                    qty,
                    "Opening balance from existing cup stock",
                    ts,
                ),
            )


def create_lot(
    db,
    pool,
    business_id,
    qty,
    unit_cost=0,
    *,
    ref_id=None,
    received_at=None,
    expiry_date=None,
    notes=None,
    source="restock",
    created_at=None,
    sync=True,
):
    """Insert a new lot and optionally sync aggregate qty/cost."""
    if pool not in VALID_POOLS:
        raise ValueError(f"Unknown pool: {pool}")
    if source not in LOT_SOURCES:
        raise ValueError(f"Unknown lot source: {source}")

    integer = pool != POOL_INGREDIENT
    qty = _parse_qty(qty, integer=integer)
    if qty <= 0:
        raise ValueError("Lot quantity must be greater than zero")

    unit_cost = max(0.0, float(unit_cost or 0))
    expiry_date = _normalize_expiry(expiry_date)
    ts = created_at or received_at
    if not ts:
        raise ValueError("created_at or received_at is required")
    received_at = received_at or ts
    notes = (notes or "").strip() or None

    table = _lot_table(pool)
    if pool == POOL_CUP:
        cur = db.execute(
            f"""INSERT INTO {table}
                (business_id, received_at, expiry_date, unit_cost,
                 qty_original, qty_remaining, notes, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                business_id,
                received_at,
                expiry_date,
                unit_cost,
                qty,
                qty,
                notes,
                source,
                ts,
            ),
        )
    else:
        ref_col = _ref_column(pool)
        if ref_id is None:
            raise ValueError(f"{ref_col} is required for {pool} lots")
        cur = db.execute(
            f"""INSERT INTO {table}
                (business_id, {ref_col}, received_at, expiry_date, unit_cost,
                 qty_original, qty_remaining, notes, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                business_id,
                ref_id,
                received_at,
                expiry_date,
                unit_cost,
                qty,
                qty,
                notes,
                source,
                ts,
            ),
        )

    lot_id = cur.lastrowid
    if sync:
        sync_pool_qty_and_cost(db, pool, business_id, ref_id, ts)
    return lot_id


def _open_lots_query(pool, business_id, ref_id=None, lot_id=None):
    table = _lot_table(pool)
    params = [business_id]
    where = ["business_id = ?", "qty_remaining > 0"]
    if pool != POOL_CUP:
        ref_col = _ref_column(pool)
        where.append(f"{ref_col} = ?")
        params.append(ref_id)
    if lot_id is not None:
        where.append("id = ?")
        params.append(lot_id)
    sql = f"""
        SELECT * FROM {table}
        WHERE {' AND '.join(where)}
        ORDER BY {_FEFO_ORDER}
    """
    return sql, params


def consume_lots(
    db,
    pool,
    business_id,
    qty,
    *,
    ref_id=None,
    lot_id=None,
    checkout_ref=None,
    transaction_id=None,
    ingredient_tx_id=None,
    cup_tx_id=None,
    created_at=None,
    sync=True,
):
    """Consume qty from open lots (FEFO or a specific lot). Returns allocations."""
    if pool not in VALID_POOLS:
        raise ValueError(f"Unknown pool: {pool}")

    integer = pool != POOL_INGREDIENT
    need = _parse_qty(qty, integer=integer)
    if need <= 0:
        return []

    sql, params = _open_lots_query(pool, business_id, ref_id=ref_id, lot_id=lot_id)
    lots = db.execute(sql, params).fetchall()
    available = sum(
        _parse_qty(r["qty_remaining"], integer=integer) for r in lots
    )
    eps = 1e-9 if not integer else 0
    if available + eps < need:
        raise InsufficientLotStock(
            f"Insufficient lot stock (need {need}, have {available})",
            available=available,
        )

    ts = created_at
    if not ts:
        raise ValueError("created_at is required")

    remaining = need
    allocations = []
    table = _lot_table(pool)

    for lot in lots:
        if remaining <= eps:
            break
        lot_qty = _parse_qty(lot["qty_remaining"], integer=integer)
        take = min(lot_qty, remaining)
        if integer:
            take = int(take)
        new_remaining = lot_qty - take
        if integer:
            new_remaining = int(new_remaining)
        else:
            new_remaining = round(new_remaining, 6)
            if abs(new_remaining) < 1e-9:
                new_remaining = 0.0

        db.execute(
            f"UPDATE {table} SET qty_remaining = ? WHERE id = ?",
            (new_remaining, lot["id"]),
        )
        db.execute(
            """INSERT INTO lot_allocations
               (business_id, pool, lot_id, ref_id, checkout_ref, transaction_id,
                ingredient_tx_id, cup_tx_id, quantity, unit_cost, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                business_id,
                pool,
                lot["id"],
                ref_id,
                checkout_ref,
                transaction_id,
                ingredient_tx_id,
                cup_tx_id,
                take,
                float(lot["unit_cost"] or 0),
                ts,
            ),
        )
        allocations.append(
            {
                "lot_id": lot["id"],
                "qty": take,
                "unit_cost": float(lot["unit_cost"] or 0),
            }
        )
        remaining = need - sum(a["qty"] for a in allocations)
        if not integer:
            remaining = round(remaining, 6)

    if sync:
        sync_pool_qty_and_cost(db, pool, business_id, ref_id, ts)
    return allocations


def weighted_unit_cost(allocations):
    """Weighted average unit cost from consume allocations."""
    total_qty = sum(float(a["qty"]) for a in allocations)
    if total_qty <= 0:
        return 0.0
    total_cost = sum(float(a["qty"]) * float(a["unit_cost"]) for a in allocations)
    return round(total_cost / total_qty, 4)


def sync_pool_qty_and_cost(db, pool, business_id, ref_id=None, ts=None):
    """Set aggregate quantity (and display cost) from remaining open lots."""
    table = _lot_table(pool)
    if pool == POOL_CUP:
        row = db.execute(
            f"""SELECT COALESCE(SUM(qty_remaining), 0) AS qty,
                      COALESCE(SUM(qty_remaining * unit_cost), 0) AS value
               FROM {table}
               WHERE business_id = ?""",
            (business_id,),
        ).fetchone()
        qty = int(row["qty"] or 0)
        if ts:
            db.execute(
                """UPDATE cup_inventory
                   SET quantity = ?, updated_at = ?
                   WHERE business_id = ?""",
                (qty, ts, business_id),
            )
        else:
            db.execute(
                "UPDATE cup_inventory SET quantity = ? WHERE business_id = ?",
                (qty, business_id),
            )
        return qty, 0.0

    ref_col = _ref_column(pool)
    row = db.execute(
        f"""SELECT COALESCE(SUM(qty_remaining), 0) AS qty,
                  COALESCE(SUM(qty_remaining * unit_cost), 0) AS value
           FROM {table}
           WHERE business_id = ? AND {ref_col} = ?""",
        (business_id, ref_id),
    ).fetchone()
    qty_raw = float(row["qty"] or 0)
    value = float(row["value"] or 0)
    avg_cost = round(value / qty_raw, 4) if qty_raw > 0 else 0.0

    if pool == POOL_PRODUCT:
        qty = int(round(qty_raw))
        if ts:
            db.execute(
                """UPDATE products
                   SET quantity = ?, cost_price = ?, updated_at = ?
                   WHERE id = ? AND business_id = ?""",
                (qty, avg_cost, ts, ref_id, business_id),
            )
        else:
            db.execute(
                """UPDATE products
                   SET quantity = ?, cost_price = ?
                   WHERE id = ? AND business_id = ?""",
                (qty, avg_cost, ref_id, business_id),
            )
    else:
        qty = round(qty_raw, 6)
        if abs(qty) < 1e-9:
            qty = 0.0
        if ts:
            db.execute(
                """UPDATE ingredients
                   SET quantity = ?, cost_per_unit = ?, updated_at = ?
                   WHERE id = ? AND business_id = ?""",
                (qty, avg_cost, ts, ref_id, business_id),
            )
        else:
            db.execute(
                """UPDATE ingredients
                   SET quantity = ?, cost_per_unit = ?
                   WHERE id = ? AND business_id = ?""",
                (qty, avg_cost, ref_id, business_id),
            )
    return qty, avg_cost


def restore_allocations(db, business_id, checkout_ref, created_at):
    """Restore qty consumed for a checkout back onto original lots (or void_restore lots)."""
    rows = db.execute(
        """SELECT * FROM lot_allocations
           WHERE business_id = ? AND checkout_ref = ? AND quantity > 0
           ORDER BY id ASC""",
        (business_id, checkout_ref),
    ).fetchall()
    if not rows:
        return 0

    restored = 0
    touched = set()  # (pool, ref_id)

    for alloc in rows:
        pool = alloc["pool"]
        table = _lot_table(pool)
        integer = pool != POOL_INGREDIENT
        qty = _parse_qty(alloc["quantity"], integer=integer)
        lot = db.execute(
            f"SELECT * FROM {table} WHERE id = ? AND business_id = ?",
            (alloc["lot_id"], business_id),
        ).fetchone()

        if lot:
            new_remaining = _parse_qty(lot["qty_remaining"], integer=integer) + qty
            if integer:
                new_remaining = int(new_remaining)
            else:
                new_remaining = round(new_remaining, 6)
            db.execute(
                f"UPDATE {table} SET qty_remaining = ? WHERE id = ?",
                (new_remaining, lot["id"]),
            )
            lot_id = lot["id"]
            ref_id = alloc["ref_id"]
        else:
            # Lot deleted — create a void_restore lot carrying the same cost.
            ref_id = alloc["ref_id"]
            lot_id = create_lot(
                db,
                pool,
                business_id,
                qty,
                float(alloc["unit_cost"] or 0),
                ref_id=ref_id,
                received_at=created_at,
                notes=f"Void restore {checkout_ref}",
                source="void_restore",
                created_at=created_at,
                sync=False,
            )

        # Reverse allocation row (negative qty) for audit.
        db.execute(
            """INSERT INTO lot_allocations
               (business_id, pool, lot_id, ref_id, checkout_ref, transaction_id,
                ingredient_tx_id, cup_tx_id, quantity, unit_cost, created_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)""",
            (
                business_id,
                pool,
                lot_id,
                ref_id,
                checkout_ref,
                -qty,
                float(alloc["unit_cost"] or 0),
                created_at,
            ),
        )
        touched.add((pool, ref_id))
        restored += 1

    for pool, ref_id in touched:
        sync_pool_qty_and_cost(db, pool, business_id, ref_id, created_at)
    return restored


def adjust_to_quantity(
    db,
    pool,
    business_id,
    new_quantity,
    *,
    ref_id=None,
    lot_id=None,
    unit_cost=0,
    expiry_date=None,
    notes=None,
    created_at=None,
):
    """
    Bring aggregate stock to new_quantity via lot create (increase) or FEFO/specific consume (decrease).
    Returns (diff, allocations_or_lot_id).
    """
    integer = pool != POOL_INGREDIENT
    target = _parse_qty(new_quantity, integer=integer)
    if target < 0:
        raise ValueError("Quantity cannot be negative")

    current, _ = sync_pool_qty_and_cost(db, pool, business_id, ref_id, created_at)
    # Re-read after sync for accuracy
    if pool == POOL_PRODUCT:
        current = int(
            db.execute(
                "SELECT quantity FROM products WHERE id = ? AND business_id = ?",
                (ref_id, business_id),
            ).fetchone()["quantity"]
        )
    elif pool == POOL_INGREDIENT:
        current = float(
            db.execute(
                "SELECT quantity FROM ingredients WHERE id = ? AND business_id = ?",
                (ref_id, business_id),
            ).fetchone()["quantity"]
        )
    else:
        current = int(
            db.execute(
                "SELECT quantity FROM cup_inventory WHERE business_id = ?",
                (business_id,),
            ).fetchone()["quantity"]
        )

    diff = target - current
    if integer:
        if diff == 0:
            return 0, []
    else:
        if abs(diff) < 1e-9:
            return 0.0, []

    ts = created_at
    if not ts:
        raise ValueError("created_at is required")

    if diff > 0:
        lot_id_new = create_lot(
            db,
            pool,
            business_id,
            diff,
            unit_cost,
            ref_id=ref_id,
            received_at=ts,
            expiry_date=expiry_date,
            notes=notes,
            source="adjustment",
            created_at=ts,
            sync=True,
        )
        return diff, [{"lot_id": lot_id_new, "qty": diff, "unit_cost": float(unit_cost or 0)}]

    # Decrease
    take = -diff if not integer else int(-diff)
    allocations = consume_lots(
        db,
        pool,
        business_id,
        take,
        ref_id=ref_id,
        lot_id=lot_id,
        created_at=ts,
        sync=True,
    )
    return diff, allocations


def list_lots(
    db,
    business_id,
    *,
    pool=None,
    ref_id=None,
    include_depleted=False,
    limit=200,
):
    """List lots for UI, optionally filtered by pool/ref."""
    pools = [pool] if pool in VALID_POOLS else list(VALID_POOLS)
    results = []

    for p in pools:
        table = _lot_table(p)
        where = ["l.business_id = ?"]
        params = [business_id]
        if not include_depleted:
            where.append("l.qty_remaining > 0")
        if p != POOL_CUP and ref_id is not None:
            where.append(f"l.{_ref_column(p)} = ?")
            params.append(ref_id)

        name_join = ""
        name_select = "NULL AS item_name"
        if p == POOL_PRODUCT:
            name_join = "LEFT JOIN products pr ON pr.id = l.product_id"
            name_select = "pr.name AS item_name"
        elif p == POOL_INGREDIENT:
            name_join = "LEFT JOIN ingredients ing ON ing.id = l.ingredient_id"
            name_select = "ing.name AS item_name"
        else:
            name_select = "'Shared Cups' AS item_name"

        ref_select = "NULL AS ref_id"
        if p == POOL_PRODUCT:
            ref_select = "l.product_id AS ref_id"
        elif p == POOL_INGREDIENT:
            ref_select = "l.ingredient_id AS ref_id"

        sql = f"""
            SELECT l.*, {name_select}, {ref_select}, '{p}' AS pool
            FROM {table} l
            {name_join}
            WHERE {' AND '.join(where)}
            ORDER BY {_FEFO_ORDER}
            LIMIT ?
        """
        for row in db.execute(sql, [*params, limit]).fetchall():
            results.append(row_to_lot(row))

    # Sort combined results FEFO-ish for UI
    def sort_key(item):
        exp = item.get("expiry_date") or "9999-99-99"
        undated = 1 if not item.get("expiry_date") else 0
        return (undated, exp, item.get("received_at") or "", item.get("id") or 0)

    results.sort(key=sort_key)
    return results[:limit]


def get_expiring_lots(db, business_id, within_days=7, now_date=None):
    """Open lots that are expired or expiring within within_days."""
    if now_date is None:
        now_date = datetime.utcnow().date()
    if hasattr(now_date, "strftime"):
        today = now_date.strftime("%Y-%m-%d")
        until = (now_date + timedelta(days=int(within_days))).strftime("%Y-%m-%d")
    else:
        today = str(now_date)[:10]
        until = today

    items = []
    for pool in VALID_POOLS:
        table = _lot_table(pool)
        name_join = ""
        name_select = "'Shared Cups' AS item_name"
        ref_select = "NULL AS ref_id"
        if pool == POOL_PRODUCT:
            name_join = "LEFT JOIN products pr ON pr.id = l.product_id"
            name_select = "pr.name AS item_name"
            ref_select = "l.product_id AS ref_id"
        elif pool == POOL_INGREDIENT:
            name_join = "LEFT JOIN ingredients ing ON ing.id = l.ingredient_id"
            name_select = "ing.name AS item_name"
            ref_select = "l.ingredient_id AS ref_id"

        rows = db.execute(
            f"""
            SELECT l.*, {name_select}, {ref_select}, ? AS pool
            FROM {table} l
            {name_join}
            WHERE l.business_id = ?
              AND l.qty_remaining > 0
              AND l.expiry_date IS NOT NULL
              AND l.expiry_date != ''
              AND l.expiry_date <= ?
            ORDER BY l.expiry_date ASC, l.id ASC
            """,
            (pool, business_id, until),
        ).fetchall()
        for row in rows:
            item = row_to_lot(row)
            item["expired"] = item["expiry_date"] < today
            item["expiring_soon"] = not item["expired"]
            items.append(item)

    items.sort(key=lambda x: (x.get("expiry_date") or "", x.get("id") or 0))
    return items


def inventory_lot_value(db, business_id):
    """Sum of remaining lot qty × unit_cost across all pools."""
    total = 0.0
    for pool, table in (
        (POOL_PRODUCT, "product_lots"),
        (POOL_INGREDIENT, "ingredient_lots"),
        (POOL_CUP, "cup_lots"),
    ):
        row = db.execute(
            f"""SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS value
               FROM {table} WHERE business_id = ?""",
            (business_id,),
        ).fetchone()
        total += float(row["value"] or 0)
    return round(total, 2)


def row_to_lot(row):
    keys = row.keys() if hasattr(row, "keys") else []
    qty_remaining = row["qty_remaining"]
    qty_original = row["qty_original"]
    unit_cost = float(row["unit_cost"] or 0)
    pool = row["pool"] if "pool" in keys else None
    value = round(float(qty_remaining) * unit_cost, 2)
    return {
        "id": row["id"],
        "pool": pool,
        "business_id": row["business_id"],
        "ref_id": row["ref_id"] if "ref_id" in keys else None,
        "item_name": row["item_name"] if "item_name" in keys else None,
        "received_at": row["received_at"],
        "expiry_date": row["expiry_date"],
        "unit_cost": unit_cost,
        "qty_original": qty_original,
        "qty_remaining": qty_remaining,
        "value": value,
        "notes": row["notes"],
        "source": row["source"],
        "created_at": row["created_at"],
    }
