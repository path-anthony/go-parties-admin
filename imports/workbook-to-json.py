#!/usr/bin/env python3
"""Block I1: read the clean-up workbook with openpyxl and write the three
tabs the import uses to imports/I1-workbook.json. Nothing else is read."""
import json
import sys
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
BOOK = HERE / "GO-Inventory-Cleanup-and-Import.xlsx"
OUT = HERE / "I1-workbook.json"


def cell(v):
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s != "" else None
    return v


def rows_of(ws, width):
    out = []
    for r in range(2, ws.max_row + 1):
        row = [cell(ws.cell(r, c).value) for c in range(1, width + 1)]
        if any(v is not None for v in row):
            out.append({"row": r, "cells": row})
    return out


def main():
    wb = openpyxl.load_workbook(BOOK, data_only=True)
    existing = wb["Existing items"]
    new = wb["New items"]
    addons = wb["Add-on groups"]
    data = {
        "existing": [
            {
                "row": r["row"],
                "id": r["cells"][0],
                "currentName": r["cells"][1],
                "suggestedName": r["cells"][2],
                "currentCategory": r["cells"][3],
                "newCategory": r["cells"][4],
                "price": r["cells"][7],
                "unit": r["cells"][8],
                "pricingNote": r["cells"][9],
                "qtyProposed": r["cells"][11],
                "action": r["cells"][15],
                "why": r["cells"][16],
                "offer": r["cells"][17],
                "qtyOnHand": r["cells"][18],
                "description": r["cells"][19],
            }
            for r in rows_of(existing, 20)
            if r["cells"][0]
        ],
        "new": [
            {
                "row": r["row"],
                "name": r["cells"][0],
                "category": r["cells"][1],
                "price": r["cells"][2],
                "unit": r["cells"][3],
                "qtyProposed": r["cells"][4],
                "pricingNote": r["cells"][5],
                "offer": r["cells"][9],
                "qtyOnHand": r["cells"][10],
                "description": r["cells"][11],
            }
            for r in rows_of(new, 12)
            if r["cells"][0]
        ],
        "addonGroups": [
            {"row": r["row"], "onItems": r["cells"][0], "groupName": r["cells"][1], "choose": r["cells"][2], "required": r["cells"][3], "options": r["cells"][4], "status": r["cells"][5]}
            for r in rows_of(addons, 8)
            if r["cells"][1]
        ],
    }
    OUT.write_text(json.dumps(data, indent=1, default=str))
    print(f"wrote {OUT.name}: {len(data['existing'])} existing, {len(data['new'])} new, {len(data['addonGroups'])} add-on rows", file=sys.stderr)


if __name__ == "__main__":
    main()
