"""WSGI entry point for PythonAnywhere (and other WSGI hosts).

On PythonAnywhere Web → WSGI configuration file, either:
  - point Source code at this project and leave this file as the entry, or
  - paste the path setup below into /var/www/ishya_pythonanywhere_com_wsgi.py
"""

import sys

# PythonAnywhere account: ishya
project_home = "/home/ishya/brew-scoop"
if project_home not in sys.path:
    sys.path.insert(0, project_home)

from app import app as application  # noqa: E402
