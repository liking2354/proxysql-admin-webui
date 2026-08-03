"""Helpers for comparing ProxySQL's MEMORY and RUNTIME configuration layers.

ProxySQL exposes each config table three times (``disk.*``, ``main.*`` and
``main.runtime_*``).  Naively diffing the row sets of MEMORY vs RUNTIME
produces two classes of false positives, both of which confuse operators into
thinking they have pending changes that "Apply All" can never clear:

1. **Static system tables** — e.g. ``mysql_collations`` holds the 375 built-in
   MySQL collations.  It has no ``runtime_mysql_collations`` counterpart at
   all, so the runtime side always reads as empty and the table appears
   permanently "out of sync".

2. **Rows that RUNTIME legitimately expands** — a single ``mysql_users`` row
   with ``frontend=1 AND backend=1`` is split by ProxySQL into *two* runtime
   rows (one per direction).  MEMORY has 1 row, RUNTIME has 2, yet the
   configuration is perfectly in sync.

3. **NULL materialised as empty string** — ProxySQL stores an unset text column
   (e.g. ``mysql_users.default_schema``) as ``NULL`` in MEMORY but renders it as
   ``''`` in the RUNTIME table.  A byte-wise row hash therefore never matches.

This module centralises the knowledge needed to compare the layers correctly so
that ``sync_service`` and the ``config_diff`` endpoint stay consistent.
"""
from __future__ import annotations

from typing import Any

from app.utils.helpers import row_hash

# Tables that exist only in MEMORY/DISK and have no ``runtime_`` counterpart.
# They are static metadata or lookup data, never applied to the runtime layer,
# and must therefore be reported as "not applicable" rather than "out of sync".
NON_RUNTIME_TABLES: frozenset[str] = frozenset({
    "mysql_collations",
})


def runtime_table_missing(table: str) -> bool:
    """Return True when *table* has no ``runtime_`` counterpart by design."""
    return table in NON_RUNTIME_TABLES


def _canonicalize(row: dict[str, Any]) -> dict[str, Any]:
    """Make a row comparable across layers.

    ProxySQL renders unset text columns as ``NULL`` in MEMORY/DISK but as an
    empty string in the ``runtime_`` tables. Collapsing both to ``''`` keeps the
    row hashes aligned; every remaining value is stringified so that ``1`` and
    ``"1"`` compare equal too.
    """
    return {
        k: "" if v is None else str(v)
        for k, v in row.items()
    }


def normalize_rows(table: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalise rows of *table* so MEMORY and RUNTIME can be compared.

    Two transformations are applied:

    * ``NULL`` values are collapsed to ``''`` and all values are stringified
      (see :func:`_canonicalize`).
    * For ``mysql_users`` only: ProxySQL stores a dual-purpose account
      (``frontend=1`` and ``backend=1``) as one MEMORY row but materialises it
      as two RUNTIME rows — one for client authentication
      (``frontend=1, backend=0``) and one for backend connections
      (``frontend=0, backend=1``).  Expanding the MEMORY row the same way makes
      the two layers directly comparable.

    Args:
        table: Config table name without any layer prefix.
        rows: Rows as returned from ``SELECT * FROM main.<table>``.

    Returns:
        A new list of rows suitable for set-based comparison. Input is not
        mutated.
    """
    canonical = [_canonicalize(r) for r in rows]

    if table != "mysql_users":
        return canonical

    expanded: list[dict[str, Any]] = []
    for row in canonical:
        if row.get("frontend") == "1" and row.get("backend") == "1":
            frontend_only = dict(row)
            frontend_only["backend"] = "0"
            backend_only = dict(row)
            backend_only["frontend"] = "0"
            expanded.append(frontend_only)
            expanded.append(backend_only)
        else:
            expanded.append(row)

    return expanded


def _hash_set(table: str, rows: list[dict[str, Any]]) -> set[str]:
    return {row_hash(r) for r in normalize_rows(table, rows)}


def compare_layers(
    table: str,
    memory_rows: list[dict[str, Any]],
    runtime_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compare MEMORY and RUNTIME rows for *table*.

    Returns a dict with:
        ``in_sync``       — True when the layers are equivalent.
        ``applicable``    — False for tables that never reach the runtime layer.
        ``only_memory``   — number of normalised rows present only in MEMORY.
        ``only_runtime``  — number of rows present only in RUNTIME.
    """
    if runtime_table_missing(table):
        # Static table: there is nothing to apply, so it is by definition in sync.
        return {
            "in_sync": True,
            "applicable": False,
            "only_memory": 0,
            "only_runtime": 0,
        }

    mem = _hash_set(table, memory_rows)
    run = _hash_set(table, runtime_rows)
    only_memory = mem - run
    only_runtime = run - mem

    return {
        "in_sync": not (only_memory or only_runtime),
        "applicable": True,
        "only_memory": len(only_memory),
        "only_runtime": len(only_runtime),
    }
