#!/usr/bin/env python3
"""Send daily Brew & Scoop sales report emails.

Run via cron, e.g. every day at 7:00 AM Kigali (UTC+2 = 05:00 UTC):

  0 5 * * * cd /path/to/brew-scoop-main && .venv/bin/python scripts/send_daily_report.py >> /var/log/brew-scoop-reports.log 2>&1

Environment variables (see .env.example):
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_USE_TLS
  BREW_SCOOP_DATABASE (optional)
  BREW_SCOOP_EXTRA_REPORT_EMAILS (optional, comma-separated)
"""

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from env_loader import load_env_file

load_env_file(os.path.join(ROOT, ".env"))

from mailer import load_smtp_config, send_email
from reporting import (
    build_admin_daily_report,
    build_seller_daily_report,
    connect_db,
    extra_report_emails,
    parse_date,
    render_admin_report_html,
    render_admin_report_text,
    render_seller_report_html,
    render_seller_report_text,
    report_recipients,
    yesterday_kigali,
)


def parse_args():
    parser = argparse.ArgumentParser(description="Send Brew & Scoop daily report emails.")
    parser.add_argument(
        "--date",
        help="Report date YYYY-MM-DD (default: yesterday in Kigali time)",
    )
    parser.add_argument(
        "--business-id",
        type=int,
        help="Only send for one business id (default: all active businesses)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build reports and print recipients without sending email",
    )
    return parser.parse_args()


def _active_businesses(db, business_id=None):
    if business_id is not None:
        row = db.execute(
            "SELECT id, name FROM businesses WHERE id = ? AND is_active = 1",
            (business_id,),
        ).fetchone()
        return [row] if row else []
    return db.execute(
        """SELECT id, name FROM businesses
           WHERE is_active = 1
           ORDER BY name COLLATE NOCASE ASC"""
    ).fetchall()


def main():
    args = parse_args()
    report_date = (args.date or yesterday_kigali()).strip()

    if not parse_date(report_date):
        print(f"Invalid report date: {report_date}", file=sys.stderr)
        return 1

    if not args.dry_run:
        try:
            load_smtp_config()
        except ValueError as exc:
            print(f"SMTP configuration error: {exc}", file=sys.stderr)
            return 1

    db = connect_db()
    try:
        businesses = _active_businesses(db, args.business_id)
        if not businesses:
            print("No active businesses found", file=sys.stderr)
            return 1

        sent = 0
        errors = 0
        extras = extra_report_emails()

        for biz in businesses:
            biz_id = biz["id"]
            biz_name = biz["name"]
            admins, sellers = report_recipients(db, business_id=biz_id)
            admin_report = build_admin_daily_report(
                db, report_date, business_id=biz_id
            )

            admin_recipients = {entry["email"] for entry in admins}
            admin_recipients.update(extras)

            if admin_recipients:
                subject = f"{biz_name} daily report — {report_date}"
                html = render_admin_report_html(admin_report)
                text = render_admin_report_text(admin_report)
                if args.dry_run:
                    print(
                        f"[dry-run] [{biz_name}] Admin report -> "
                        f"{', '.join(sorted(admin_recipients))}"
                    )
                else:
                    try:
                        send_email(sorted(admin_recipients), subject, html, text)
                        sent += 1
                        print(
                            f"Sent [{biz_name}] admin report to "
                            f"{len(admin_recipients)} recipient(s)"
                        )
                    except Exception as exc:
                        errors += 1
                        print(
                            f"Failed [{biz_name}] admin report: {exc}",
                            file=sys.stderr,
                        )
            else:
                print(f"[{biz_name}] No admin recipients with email configured")

            for seller in sellers:
                seller_report = build_seller_daily_report(
                    db,
                    seller["id"],
                    seller["display_name"],
                    report_date,
                    business_id=biz_id,
                )
                subject = f"Your {biz_name} sales — {report_date}"
                html = render_seller_report_html(seller_report)
                text = render_seller_report_text(seller_report)
                if args.dry_run:
                    print(
                        f"[dry-run] [{biz_name}] Seller report -> "
                        f"{seller['email']} ({seller['display_name']})"
                    )
                    continue
                try:
                    send_email([seller["email"]], subject, html, text)
                    sent += 1
                    print(
                        f"Sent [{biz_name}] seller report to "
                        f"{seller['display_name']} <{seller['email']}>"
                    )
                except Exception as exc:
                    errors += 1
                    print(
                        f"Failed [{biz_name}] seller report for "
                        f"{seller['display_name']}: {exc}",
                        file=sys.stderr,
                    )

        if args.dry_run:
            print(f"Dry run complete for {report_date}")
            return 0

        if sent == 0 and errors == 0:
            print("Nothing sent — configure user emails in Admin > Team")
            return 0

        if errors:
            print(f"Finished with {sent} sent, {errors} failed", file=sys.stderr)
            return 1

        print(f"Finished — {sent} email(s) sent for {report_date}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
