"""Daily sales report data and HTML builders for Brew & Scoop."""

import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from html import escape

KIGALI_OFFSET = timedelta(hours=2)

PAYMENT_METHODS = {
    "momo": "MoMo",
    "cash": "Cash",
    "visa": "Visa",
}


def get_database_path():
    return os.environ.get(
        "BREW_SCOOP_DATABASE",
        os.path.join(os.path.dirname(__file__), "brew_scoop.db"),
    )


def connect_db():
    db = sqlite3.connect(get_database_path())
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def now_kigali():
    return datetime.now(timezone.utc) + KIGALI_OFFSET


def today_kigali():
    return now_kigali().strftime("%Y-%m-%d")


def yesterday_kigali():
    return (now_kigali().date() - timedelta(days=1)).strftime("%Y-%m-%d")


def parse_date(value):
    if not value or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def format_currency(amount):
    return f"{amount:,.0f} RWF"


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


def _sale_business_clause(business_id, alias=""):
    if business_id is None:
        return "", []
    try:
        biz_id = int(business_id)
    except (TypeError, ValueError):
        return "", []
    prefix = f"{alias}." if alias else ""
    return f" AND {prefix}business_id = ?", [biz_id]


NOT_VOIDED = " AND voided_at IS NULL"
NOT_VOIDED_T = " AND t.voided_at IS NULL"


def _profit_metrics(revenue, cogs):
    revenue = float(revenue or 0)
    cogs = float(cogs or 0)
    gross_profit = round(revenue - cogs, 2)
    gross_margin_pct = (
        round((gross_profit / revenue) * 100, 1) if revenue > 0 else None
    )
    return {
        "cogs": round(cogs, 2),
        "gross_profit": gross_profit,
        "gross_margin_pct": gross_margin_pct,
    }


def sales_summary(db, date_from, date_to, user_id=None, business_id=None):
    user_clause, user_params = _sale_user_clause(user_id)
    biz_clause, biz_params = _sale_business_clause(business_id)
    row = db.execute(
        f"""SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                  COALESCE(SUM(COALESCE(cost_price, 0) * quantity), 0) AS cogs,
                  COALESCE(SUM(quantity), 0) AS units,
                  COUNT(*) AS transactions
           FROM transactions
           WHERE type = 'sale'{NOT_VOIDED}
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?{user_clause}{biz_clause}""",
        (date_from, date_to, *user_params, *biz_params),
    ).fetchone()
    metrics = _profit_metrics(row["revenue"], row["cogs"])
    return {
        "revenue": round(row["revenue"], 2),
        "units": row["units"],
        "transactions": row["transactions"],
        **metrics,
    }


def payment_breakdown(db, date_from, date_to, user_id=None, business_id=None):
    user_clause, user_params = _sale_user_clause(user_id)
    biz_clause, biz_params = _sale_business_clause(business_id)
    rows = db.execute(
        f"""SELECT payment_method,
                  COALESCE(SUM(total_amount), 0) AS revenue,
                  COUNT(DISTINCT checkout_ref) AS checkouts
           FROM transactions
           WHERE type = 'sale'{NOT_VOIDED}
             AND payment_method IS NOT NULL
             AND substr(created_at, 1, 10) >= ?
             AND substr(created_at, 1, 10) <= ?{user_clause}{biz_clause}
           GROUP BY payment_method""",
        (date_from, date_to, *user_params, *biz_params),
    ).fetchall()
    totals = {row["payment_method"]: row for row in rows}
    return [
        {
            "method": method,
            "label": label,
            "revenue": round(totals[method]["revenue"], 2) if method in totals else 0,
            "checkouts": totals[method]["checkouts"] if method in totals else 0,
        }
        for method, label in PAYMENT_METHODS.items()
    ]


def category_breakdown(db, date_from, date_to, user_id=None, business_id=None):
    user_clause, user_params = _sale_user_clause(user_id, "t")
    biz_clause, biz_params = _sale_business_clause(business_id, "t")
    rows = db.execute(
        f"""SELECT p.category,
                  COALESCE(SUM(t.total_amount), 0) AS revenue,
                  COALESCE(SUM(t.quantity), 0) AS units,
                  COUNT(t.id) AS transactions
           FROM transactions t
           JOIN products p ON p.id = t.product_id
           WHERE t.type = 'sale'{NOT_VOIDED_T}
             AND substr(t.created_at, 1, 10) >= ?
             AND substr(t.created_at, 1, 10) <= ?{user_clause}{biz_clause}
           GROUP BY p.category
           ORDER BY revenue DESC, p.category COLLATE NOCASE ASC""",
        (date_from, date_to, *user_params, *biz_params),
    ).fetchall()
    return [
        {
            "name": row["category"],
            "revenue": round(row["revenue"], 2),
            "units": row["units"],
            "transactions": row["transactions"],
        }
        for row in rows
    ]


def seller_breakdown(db, report_date, business_id=None):
    biz_clause, biz_params = _sale_business_clause(business_id, "t")
    membership_join = ""
    membership_where = "u.role = 'seller' AND u.is_active = 1"
    membership_params = []
    if business_id is not None:
        membership_join = """
           JOIN user_business_memberships m
             ON m.user_id = u.id
            AND m.business_id = ?
            AND m.role = 'seller'
            AND m.is_active = 1
        """
        membership_where = "u.is_active = 1"
        membership_params = [business_id]
    rows = db.execute(
        f"""SELECT u.id,
                  u.display_name,
                  COALESCE(SUM(t.total_amount), 0) AS revenue,
                  COALESCE(SUM(t.quantity), 0) AS units,
                  COUNT(t.id) AS transactions
           FROM users u
           {membership_join}
           LEFT JOIN transactions t
             ON t.user_id = u.id
            AND t.type = 'sale'{NOT_VOIDED_T}
            AND substr(t.created_at, 1, 10) = ?
            {biz_clause}
           WHERE {membership_where}
           GROUP BY u.id
           ORDER BY revenue DESC, u.display_name COLLATE NOCASE ASC""",
        (*membership_params, report_date, *biz_params),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "display_name": row["display_name"],
            "revenue": round(row["revenue"], 2),
            "units": row["units"],
            "transactions": row["transactions"],
        }
        for row in rows
    ]


def top_products_for_day(db, report_date, limit=5, user_id=None, business_id=None):
    user_clause, user_params = _sale_user_clause(user_id, "t")
    biz_clause, biz_params = _sale_business_clause(business_id, "t")
    rows = db.execute(
        f"""SELECT p.name,
                  COALESCE(SUM(t.quantity), 0) AS units,
                  COALESCE(SUM(t.total_amount), 0) AS revenue
           FROM transactions t
           JOIN products p ON p.id = t.product_id
           WHERE t.type = 'sale'{NOT_VOIDED_T}
             AND substr(t.created_at, 1, 10) = ?{user_clause}{biz_clause}
           GROUP BY p.id
           ORDER BY units DESC, revenue DESC
           LIMIT ?""",
        (report_date, *user_params, *biz_params, limit),
    ).fetchall()
    return [
        {
            "name": row["name"],
            "units": row["units"],
            "revenue": round(row["revenue"], 2),
        }
        for row in rows
    ]


def low_stock_items(db, limit=8, business_id=None):
    if business_id is None:
        cats = db.execute("SELECT name, uses_cup_stock FROM categories").fetchall()
        cup = db.execute(
            "SELECT quantity, reorder_level FROM cup_inventory LIMIT 1"
        ).fetchone()
        products = db.execute("SELECT * FROM products").fetchall()
    else:
        cats = db.execute(
            "SELECT name, uses_cup_stock FROM categories WHERE business_id = ?",
            (business_id,),
        ).fetchall()
        cup = db.execute(
            "SELECT quantity, reorder_level FROM cup_inventory WHERE business_id = ?",
            (business_id,),
        ).fetchone()
        products = db.execute(
            "SELECT * FROM products WHERE business_id = ?", (business_id,)
        ).fetchall()
    category_cup_map = {
        row["name"]: bool(row["uses_cup_stock"]) for row in cats
    }
    items = []

    for row in products:
        if category_cup_map.get(row["category"], False):
            continue
        qty = row["quantity"]
        reorder = row["reorder_level"]
        if qty <= reorder:
            status = "out" if qty == 0 else "low"
            items.append(
                {
                    "name": row["name"],
                    "quantity": qty,
                    "reorder_level": reorder,
                    "status": status,
                }
            )

    if cup and cup["quantity"] <= cup["reorder_level"]:
        items.append(
            {
                "name": "Shared cups",
                "quantity": cup["quantity"],
                "reorder_level": cup["reorder_level"],
                "status": "out" if cup["quantity"] == 0 else "low",
            }
        )

    items.sort(key=lambda item: (0 if item["status"] == "out" else 1, item["quantity"]))
    return items[:limit]


def seller_shifts_for_day(db, user_id, report_date, business_id=None):
    query = """
        SELECT status, opened_at, closed_at, total_sales, cash_sales,
               momo_sales, visa_sales, units_sold, sale_count, variance,
               counted_cash, expected_cash
        FROM seller_shifts
        WHERE user_id = ?
          AND (substr(opened_at, 1, 10) = ? OR substr(closed_at, 1, 10) = ?)
    """
    params = [user_id, report_date, report_date]
    if business_id is not None:
        query += " AND business_id = ?"
        params.append(int(business_id))
    query += " ORDER BY opened_at ASC"
    rows = db.execute(query, params).fetchall()
    return [dict(row) for row in rows]


def report_recipients(db, business_id=None):
    if business_id is not None:
        rows = db.execute(
            """SELECT u.id, u.display_name, u.email, m.role
               FROM users u
               JOIN user_business_memberships m
                 ON m.user_id = u.id AND m.business_id = ?
               WHERE u.is_active = 1
                 AND m.is_active = 1
                 AND u.email IS NOT NULL
                 AND TRIM(u.email) != ''""",
            (int(business_id),),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT id, display_name, email, role
               FROM users
               WHERE is_active = 1
                 AND email IS NOT NULL
                 AND TRIM(email) != ''"""
        ).fetchall()
    admin_roles = {"admin", "supervisor", "stock_manager"}
    admins = []
    sellers = []
    for row in rows:
        entry = {
            "id": row["id"],
            "display_name": row["display_name"],
            "email": row["email"].strip(),
            "role": row["role"],
        }
        if row["role"] in admin_roles:
            admins.append(entry)
        elif row["role"] == "seller":
            sellers.append(entry)
    return admins, sellers


def extra_report_emails():
    raw = os.environ.get("BREW_SCOOP_EXTRA_REPORT_EMAILS", "")
    return [part.strip() for part in raw.split(",") if part.strip()]


def build_admin_daily_report(db, report_date, business_id=None):
    return {
        "report_date": report_date,
        "business_id": business_id,
        "summary": sales_summary(
            db, report_date, report_date, business_id=business_id
        ),
        "payments": payment_breakdown(
            db, report_date, report_date, business_id=business_id
        ),
        "categories": category_breakdown(
            db, report_date, report_date, business_id=business_id
        ),
        "sellers": seller_breakdown(db, report_date, business_id=business_id),
        "top_products": top_products_for_day(
            db, report_date, business_id=business_id
        ),
        "low_stock": low_stock_items(db, business_id=business_id),
    }


def build_seller_daily_report(db, user_id, display_name, report_date, business_id=None):
    return {
        "report_date": report_date,
        "business_id": business_id,
        "seller_name": display_name,
        "summary": sales_summary(
            db, report_date, report_date, user_id=user_id, business_id=business_id
        ),
        "payments": payment_breakdown(
            db, report_date, report_date, user_id=user_id, business_id=business_id
        ),
        "categories": category_breakdown(
            db, report_date, report_date, user_id=user_id, business_id=business_id
        ),
        "top_products": top_products_for_day(
            db, report_date, user_id=user_id, business_id=business_id
        ),
        "shifts": seller_shifts_for_day(
            db, user_id, report_date, business_id=business_id
        ),
    }


def _email_shell(title, body_html):
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{escape(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#2b2118;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ec;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6ddd1;">
          <tr>
            <td style="background:#5c3d2e;color:#ffffff;padding:20px 24px;">
              <h1 style="margin:0;font-size:22px;">Brew &amp; Scoop</h1>
              <p style="margin:6px 0 0;font-size:14px;opacity:0.9;">{escape(title)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">{body_html}</td>
          </tr>
          <tr>
            <td style="padding:16px 24px;background:#faf7f2;color:#7a6a5c;font-size:12px;">
              Automated daily report from Brew &amp; Scoop.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _stat_cards(items):
    cards = []
    for label, value in items:
        cards.append(
            f"""<td style="width:33%;padding:8px;">
              <div style="background:#faf7f2;border:1px solid #ece3d8;border-radius:10px;padding:14px;">
                <div style="font-size:12px;color:#7a6a5c;text-transform:uppercase;letter-spacing:0.04em;">{escape(label)}</div>
                <div style="font-size:22px;font-weight:bold;margin-top:6px;color:#2b2118;">{escape(value)}</div>
              </div>
            </td>"""
        )
    return f'<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>{"".join(cards)}</tr></table>'


def _table(headers, rows):
    head = "".join(
        f'<th align="left" style="padding:10px 12px;background:#faf7f2;border-bottom:1px solid #ece3d8;">{escape(h)}</th>'
        for h in headers
    )
    body_rows = []
    for row in rows:
        cells = "".join(
            f'<td style="padding:10px 12px;border-bottom:1px solid #f0ebe4;">{cell}</td>'
            for cell in row
        )
        body_rows.append(f"<tr>{cells}</tr>")
    if not body_rows:
        body_rows.append(
            f'<tr><td colspan="{len(headers)}" style="padding:14px 12px;color:#7a6a5c;">No data for this period.</td></tr>'
        )
    return f"""<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:12px;">
      <thead><tr>{head}</tr></thead>
      <tbody>{"".join(body_rows)}</tbody>
    </table>"""


def _section(title, content):
    return f"""<div style="margin-top:24px;">
      <h2 style="margin:0 0 8px;font-size:16px;color:#5c3d2e;">{escape(title)}</h2>
      {content}
    </div>"""


def render_admin_report_html(report):
    summary = report["summary"]
    body = _stat_cards(
        [
            ("Revenue", format_currency(summary["revenue"])),
            ("Units sold", str(summary["units"])),
            ("Transactions", str(summary["transactions"])),
        ]
    )

    payment_rows = [
        (
            escape(p["label"]),
            format_currency(p["revenue"]),
            str(p["checkouts"]),
        )
        for p in report["payments"]
    ]
    body += _section("Payment breakdown", _table(["Method", "Revenue", "Checkouts"], payment_rows))

    category_rows = [
        (
            escape(c["name"]),
            format_currency(c["revenue"]),
            str(c["units"]),
            str(c["transactions"]),
        )
        for c in report.get("categories", [])
    ]
    body += _section("Sales by category", _table(["Category", "Revenue", "Units", "Sales"], category_rows))

    seller_rows = [
        (
            escape(s["display_name"]),
            format_currency(s["revenue"]),
            str(s["units"]),
            str(s["transactions"]),
        )
        for s in report["sellers"]
        if s["transactions"] > 0
    ]
    body += _section("Seller performance", _table(["Seller", "Revenue", "Units", "Sales"], seller_rows))

    product_rows = [
        (escape(p["name"]), str(p["units"]), format_currency(p["revenue"]))
        for p in report["top_products"]
    ]
    body += _section("Top products", _table(["Product", "Units", "Revenue"], product_rows))

    if report["low_stock"]:
        stock_rows = [
            (
                escape(item["name"]),
                str(item["quantity"]),
                str(item["reorder_level"]),
                "Out of stock" if item["status"] == "out" else "Low stock",
            )
            for item in report["low_stock"]
        ]
        body += _section("Stock alerts", _table(["Item", "Qty", "Reorder at", "Status"], stock_rows))

    title = f"Daily store report — {report['report_date']}"
    return _email_shell(title, body)


def render_admin_report_text(report):
    summary = report["summary"]
    lines = [
        f"Brew & Scoop daily store report — {report['report_date']}",
        "",
        f"Revenue: {format_currency(summary['revenue'])}",
        f"Units sold: {summary['units']}",
        f"Transactions: {summary['transactions']}",
        "",
        "Payment breakdown:",
    ]
    for p in report["payments"]:
        lines.append(f"  {p['label']}: {format_currency(p['revenue'])} ({p['checkouts']} checkouts)")
    lines.extend(["", "Sales by category:"])
    for c in report.get("categories", []):
        lines.append(
            f"  {c['name']}: {format_currency(c['revenue'])}, "
            f"{c['units']} units, {c['transactions']} sales"
        )
    lines.extend(["", "Seller performance:"])
    for s in report["sellers"]:
        if s["transactions"] > 0:
            lines.append(
                f"  {s['display_name']}: {format_currency(s['revenue'])}, "
                f"{s['units']} units, {s['transactions']} sales"
            )
    return "\n".join(lines)


def render_seller_report_html(report):
    summary = report["summary"]
    body = _stat_cards(
        [
            ("Your revenue", format_currency(summary["revenue"])),
            ("Units sold", str(summary["units"])),
            ("Transactions", str(summary["transactions"])),
        ]
    )

    payment_rows = [
        (escape(p["label"]), format_currency(p["revenue"]), str(p["checkouts"]))
        for p in report["payments"]
    ]
    body += _section("Payment breakdown", _table(["Method", "Revenue", "Checkouts"], payment_rows))

    category_rows = [
        (
            escape(c["name"]),
            format_currency(c["revenue"]),
            str(c["units"]),
            str(c["transactions"]),
        )
        for c in report.get("categories", [])
    ]
    body += _section("Your sales by category", _table(["Category", "Revenue", "Units", "Sales"], category_rows))

    product_rows = [
        (escape(p["name"]), str(p["units"]), format_currency(p["revenue"]))
        for p in report["top_products"]
    ]
    body += _section("Your top products", _table(["Product", "Units", "Revenue"], product_rows))

    if report["shifts"]:
        shift_rows = []
        for shift in report["shifts"]:
            status = shift["status"].title()
            total = format_currency(shift["total_sales"] or 0)
            if shift["status"] == "closed" and shift["variance"] is not None:
                variance = format_currency(abs(shift["variance"]))
                note = "Balanced" if shift["variance"] == 0 else f"Variance {variance}"
            else:
                note = "Still open" if shift["status"] == "open" else "Closed"
            shift_rows.append((status, total, escape(note)))
        body += _section("Shifts", _table(["Status", "Total sales", "Notes"], shift_rows))

    title = f"Your daily sales — {report['report_date']}"
    return _email_shell(title, body)


def render_seller_report_text(report):
    summary = report["summary"]
    lines = [
        f"Brew & Scoop daily sales for {report['seller_name']} — {report['report_date']}",
        "",
        f"Revenue: {format_currency(summary['revenue'])}",
        f"Units sold: {summary['units']}",
        f"Transactions: {summary['transactions']}",
    ]
    return "\n".join(lines)


SHIFT_STATUS_STYLES = {
    "balanced": ("Balanced", "#1f7a4d", "#e7f4ec"),
    "short": ("Short", "#b3261e", "#fbe9e7"),
    "over": ("Over", "#8a6d1f", "#fbf3d9"),
}

SHIFT_REPORT_LABELS = (
    ("report_low_stock", "Low stock / to restock"),
    ("report_issues", "Issues met"),
    ("report_wishes", "Wishes / suggestions"),
    ("concerns", "Other notes"),
)


def _format_shift_datetime(value):
    if not value:
        return "—"
    try:
        parsed = datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
    except (ValueError, TypeError):
        return value
    return parsed.strftime("%b %d, %Y · %H:%M")


def _format_variance(variance):
    variance = variance or 0
    if variance == 0:
        return "Balanced"
    sign = "+" if variance > 0 else "-"
    return f"{sign}{format_currency(abs(variance))}"


def _shift_report_entries(shift):
    return [
        (label, shift.get(key))
        for key, label in SHIFT_REPORT_LABELS
        if shift.get(key)
    ]


def _shift_total_variance(shift):
    return round(
        (shift.get("variance") or 0)
        + (shift.get("momo_variance") or 0)
        + (shift.get("visa_variance") or 0),
        2,
    )


def _shift_summary_sentence(shift, seller_name):
    total_sales = shift.get("total_sales") or 0
    units = shift.get("units_sold") or 0
    sale_count = shift.get("sale_count") or 0
    status = shift.get("status_label") or "balanced"
    total_variance = _shift_total_variance(shift)

    parts = [
        f"{seller_name} sold {format_currency(total_sales)} "
        f"({units} unit{'s' if units != 1 else ''} across "
        f"{sale_count} sale{'s' if sale_count != 1 else ''})."
    ]
    if status == "balanced" or total_variance == 0:
        parts.append("All payment counts matched the recorded sales.")
    elif total_variance > 0:
        parts.append(
            f"The till came out over by {format_currency(abs(total_variance))} "
            "versus recorded sales."
        )
    else:
        parts.append(
            f"The till fell short by {format_currency(abs(total_variance))} "
            "versus recorded sales."
        )
    return " ".join(parts)


def _aggregate_shift_products(shift, limit=8):
    totals = {}
    for sale in shift.get("sales") or []:
        if sale.get("is_voided"):
            continue
        name = sale.get("product_name") or "Unknown"
        entry = totals.setdefault(name, {"units": 0, "revenue": 0})
        entry["units"] += sale.get("quantity") or 0
        entry["revenue"] += sale.get("total_amount") or 0
    ranked = sorted(
        totals.items(),
        key=lambda kv: (kv[1]["revenue"], kv[1]["units"]),
        reverse=True,
    )
    return ranked[:limit]


def render_shift_close_html(shift, seller_name):
    status = shift.get("status_label") or "balanced"
    label, color, bg = SHIFT_STATUS_STYLES.get(status, SHIFT_STATUS_STYLES["balanced"])
    badge = (
        f'<span style="display:inline-block;padding:3px 12px;border-radius:999px;'
        f'background:{bg};color:{color};font-size:13px;font-weight:bold;">'
        f"{escape(label)}</span>"
    )

    body = (
        f'<div style="margin-bottom:8px;">'
        f'<p style="margin:0 0 6px;font-size:15px;">'
        f"<strong>{escape(seller_name)}</strong> just closed a shift. {badge}</p>"
        f'<p style="margin:0;color:#7a6a5c;font-size:13px;">'
        f"{escape(_format_shift_datetime(shift.get('opened_at')))} &rarr; "
        f"{escape(_format_shift_datetime(shift.get('closed_at')))}</p>"
        f"</div>"
    )

    body += (
        f'<div style="margin-top:16px;background:{bg};border:1px solid {color}33;'
        f'border-left:4px solid {color};border-radius:10px;padding:14px 16px;">'
        f'<p style="margin:0;font-size:14px;color:#2b2118;line-height:1.5;">'
        f"{escape(_shift_summary_sentence(shift, seller_name))}</p>"
        f"</div>"
    )

    body += _stat_cards(
        [
            ("Total sales", format_currency(shift.get("total_sales") or 0)),
            ("Units sold", str(shift.get("units_sold") or 0)),
            ("Sales", str(shift.get("sale_count") or 0)),
        ]
    )

    recon_rows = [
        (
            "Cash",
            format_currency(shift.get("counted_cash") or 0),
            format_currency(shift.get("expected_cash") or 0),
            _format_variance(shift.get("variance")),
        ),
        (
            "MoMo",
            format_currency(shift.get("counted_momo") or 0),
            format_currency(shift.get("expected_momo") or 0),
            _format_variance(shift.get("momo_variance")),
        ),
        (
            "Visa",
            format_currency(shift.get("counted_visa") or 0),
            format_currency(shift.get("expected_visa") or 0),
            _format_variance(shift.get("visa_variance")),
        ),
    ]
    body += _section(
        "Payment reconciliation",
        _table(["Method", "Counted", "Expected", "Variance"], recon_rows),
    )

    sales_rows = [
        ("Cash", format_currency(shift.get("cash_sales") or 0)),
        ("MoMo", format_currency(shift.get("momo_sales") or 0)),
        ("Visa", format_currency(shift.get("visa_sales") or 0)),
    ]
    body += _section(
        "Sales by payment method",
        _table(["Method", "Recorded sales"], sales_rows),
    )

    product_totals = _aggregate_shift_products(shift)
    if product_totals:
        product_rows = [
            (escape(name), str(data["units"]), format_currency(data["revenue"]))
            for name, data in product_totals
        ]
        body += _section(
            "What sold this shift",
            _table(["Product", "Units", "Revenue"], product_rows),
        )

    notes = shift.get("cash_notes") or {}
    denom_rows = []
    for denom in ("5000", "2000", "1000", "500", "100", "50"):
        qty = notes.get(denom) or notes.get(int(denom)) or 0
        if qty:
            denom_rows.append(
                (f"{int(denom):,}", str(qty), format_currency(int(denom) * qty))
            )
    if denom_rows:
        body += _section(
            "Cash notes counted",
            _table(["Denomination", "Qty", "Subtotal"], denom_rows),
        )

    report_entries = _shift_report_entries(shift)
    if report_entries:
        blocks = ""
        for label, value in report_entries:
            blocks += (
                f'<div style="margin-top:10px;">'
                f'<div style="font-size:12px;font-weight:bold;text-transform:uppercase;'
                f'letter-spacing:0.04em;color:#8a6d1f;">{escape(label)}</div>'
                f'<div style="margin-top:2px;white-space:pre-wrap;">{escape(value)}</div>'
                f"</div>"
            )
        report_box = (
            f'<div style="background:#fdf4e3;border:1px solid #ecd9b0;border-radius:10px;'
            f'padding:12px 16px;">{blocks}</div>'
        )
        body += _section("Seller's end-of-shift report", report_box)

    title = f"Shift closed — {seller_name}"
    return _email_shell(title, body).replace(
        "Automated daily report from Brew &amp; Scoop.",
        "Shift close notification from Brew &amp; Scoop.",
    )


def render_shift_close_text(shift, seller_name):
    status = (shift.get("status_label") or "balanced").title()
    lines = [
        f"Shift closed — {seller_name}",
        f"{_format_shift_datetime(shift.get('opened_at'))} -> "
        f"{_format_shift_datetime(shift.get('closed_at'))}",
        f"Status: {status}",
        "",
        _shift_summary_sentence(shift, seller_name),
        "",
        f"Total sales: {format_currency(shift.get('total_sales') or 0)}",
        f"Units sold: {shift.get('units_sold') or 0}",
        f"Sales: {shift.get('sale_count') or 0}",
        "",
        "Payment reconciliation (counted / expected / variance):",
        f"  Cash: {format_currency(shift.get('counted_cash') or 0)} / "
        f"{format_currency(shift.get('expected_cash') or 0)} / "
        f"{_format_variance(shift.get('variance'))}",
        f"  MoMo: {format_currency(shift.get('counted_momo') or 0)} / "
        f"{format_currency(shift.get('expected_momo') or 0)} / "
        f"{_format_variance(shift.get('momo_variance'))}",
        f"  Visa: {format_currency(shift.get('counted_visa') or 0)} / "
        f"{format_currency(shift.get('expected_visa') or 0)} / "
        f"{_format_variance(shift.get('visa_variance'))}",
    ]
    product_totals = _aggregate_shift_products(shift)
    if product_totals:
        lines.extend(["", "What sold this shift:"])
        lines.extend(
            f"  {name}: {data['units']} units, {format_currency(data['revenue'])}"
            for name, data in product_totals
        )
    report_entries = _shift_report_entries(shift)
    if report_entries:
        lines.extend(["", "Seller's end-of-shift report:"])
        lines.extend(f"  {label}: {value}" for label, value in report_entries)
    return "\n".join(lines)
