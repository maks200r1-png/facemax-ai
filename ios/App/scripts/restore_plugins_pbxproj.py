#!/usr/bin/env python3
"""
restore_plugins_pbxproj.py

`npx cap sync ios` rewrites App.xcodeproj/project.pbxproj and removes any
source files that are not registered as npm Capacitor plugins — including our
hand-rolled CameraOvalPlugin and ScreenshotPlugin.

This script re-injects exactly the entries Xcode needs so both plugins are
compiled into every build. Run it right after `cap sync`.

Design note — anchoring strategy:
Every entry is inserted directly after a STABLE anchor line that:
  (a) already exists in a freshly-`cap sync`'d pbxproj (i.e. it's part of the
      base Capacitor/Xcode template, never one of our own injected lines), and
  (b) sits INSIDE the correct nested list (the App group's `children = ( ... )`,
      or the Sources phase's `files = ( ... )`) — not after the whole-file
      "/* End <Section> section */" marker.
Point (b) matters because PBXBuildFile and PBXFileReference are flat,
unnested lists (every entry is a self-contained `key = {...};`), so anchoring
on the section-end marker is valid there. PBXGroup and PBXSourcesBuildPhase
are NOT flat — PBXGroup holds multiple independent groups, each with its own
parenthesized children list, and PBXSourcesBuildPhase wraps its file list in
`files = ( ... );`. Inserting before the section-end marker for those two
sections places the lines outside any enclosing list, which is invalid plist
syntax (this was a real bug shipped in an earlier version of this script —
it passed every check here because the checks only verified the lines were
*present in the file*, not that they were inside the right parentheses; the
actual failure only showed up later, in CocoaPods' plist parser).
"""

import sys
import os
import re

sys.path.insert(0, os.path.dirname(__file__))
from validate_pbxproj import validate_text, ParseError  # noqa: E402

PBXPROJ = os.path.join(
    os.path.dirname(__file__),
    "..", "App.xcodeproj", "project.pbxproj"
)

# Each entry: (section_label, anchor_line, [lines_to_ensure_present_after_anchor])
# Lines are inserted directly after the anchor line, in order, skipping any
# that are already present anywhere in the file.

SECTIONS = [
    (
        # Flat list of independent `key = {...};` entries — safe to anchor on
        # any pre-existing entry. We use the AppDelegate.swift entry since it's
        # part of the base template and always present.
        "PBXBuildFile",
        "504EC3081FED79650016851F /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 504EC3071FED79650016851F /* AppDelegate.swift */; };",
        [
            "\t\tAA0000000000000000000002 /* ScreenshotPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = AA0000000000000000000001 /* ScreenshotPlugin.swift */; };",
            "\t\tAA0000000000000000000004 /* ScreenshotPlugin.m in Sources */ = {isa = PBXBuildFile; fileRef = AA0000000000000000000003 /* ScreenshotPlugin.m */; };",
            "\t\tBB0000000000000000000002 /* CameraOvalPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = BB0000000000000000000001 /* CameraOvalPlugin.swift */; };",
            "\t\tBB0000000000000000000004 /* CameraOvalPlugin.m in Sources */ = {isa = PBXBuildFile; fileRef = BB0000000000000000000003 /* CameraOvalPlugin.m */; };",












        ],
    ),
    (
        # Also a flat list — anchor on the AppDelegate.swift PBXFileReference,
        # part of the base template.
        "PBXFileReference",
        "504EC3071FED79650016851F /* AppDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = \"<group>\"; };",
        [
            "\t\tAA0000000000000000000001 /* ScreenshotPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ScreenshotPlugin.swift; sourceTree = \"<group>\"; };",
            "\t\tAA0000000000000000000003 /* ScreenshotPlugin.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = ScreenshotPlugin.m; sourceTree = \"<group>\"; };",
            "\t\tBB0000000000000000000001 /* CameraOvalPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = CameraOvalPlugin.swift; sourceTree = \"<group>\"; };",
            "\t\tBB0000000000000000000003 /* CameraOvalPlugin.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = CameraOvalPlugin.m; sourceTree = \"<group>\"; };",












        ],
    ),
    (
        # NOT flat — must anchor INSIDE the App group's children list.
        # "public" (the web assets folder reference) is always the last child
        # of the App group and is part of the native Xcode project structure,
        # not something `cap sync` manages, so it survives every sync.
        "PBXGroup (App group children)",
        "\t\t\t\t50B271D01FEDC1A000F3C39B /* public */,",
        [
            "\t\t\t\tAA0000000000000000000001 /* ScreenshotPlugin.swift */,",
            "\t\t\t\tAA0000000000000000000003 /* ScreenshotPlugin.m */,",
            "\t\t\t\tBB0000000000000000000001 /* CameraOvalPlugin.swift */,",
            "\t\t\t\tBB0000000000000000000003 /* CameraOvalPlugin.m */,",












        ],
    ),
    (
        # NOT flat — must anchor INSIDE the Sources phase's files list.
        # AppDelegate.swift in Sources is part of the base template.
        "PBXSourcesBuildPhase (files list)",
        "\t\t\t\t504EC3081FED79650016851F /* AppDelegate.swift in Sources */,",
        [
            "\t\t\t\tAA0000000000000000000002 /* ScreenshotPlugin.swift in Sources */,",
            "\t\t\t\tAA0000000000000000000004 /* ScreenshotPlugin.m in Sources */,",
            "\t\t\t\tBB0000000000000000000002 /* CameraOvalPlugin.swift in Sources */,",
            "\t\t\t\tBB0000000000000000000004 /* CameraOvalPlugin.m in Sources */,",

        ],
    ),
]

REQUIRED_LINES = [line for _, _, lines in SECTIONS for line in lines]

# Legacy alternate-icon files existed in an older project revision. `cap sync`
# can preserve stale references in project.pbxproj even when the actual files no
# longer exist, which makes Xcode fail during Archive with CopyPNGFile errors.
# The app now uses only Assets.xcassets/AppIcon.appiconset, so all references to
# these legacy items must be removed before restoring the real custom plugins.
LEGACY_ALT_ICON_PATTERNS = (
    "AltIcons",
    "AppIcon-Streak",
    "AppIconPlugin",
)
PBX_OBJECT_HEADER_RE = re.compile(r"^\s*([A-F0-9]{24})\s+/\*.*?\*/\s*=\s*\{")
PBX_ID_RE = re.compile(r"\b[A-F0-9]{24}\b")


def _object_blocks(lines: list[str]) -> list[tuple[int, int, str, str]]:
    """Return (start, end_exclusive, object_id, block_text) for pbx objects."""
    blocks = []
    i = 0
    while i < len(lines):
        match = PBX_OBJECT_HEADER_RE.match(lines[i])
        if not match:
            i += 1
            continue

        start = i
        depth = 0
        seen_open = False
        while i < len(lines):
            line = lines[i]
            depth += line.count("{") - line.count("}")
            if "{" in line:
                seen_open = True
            i += 1
            if seen_open and depth <= 0:
                break

        end = i
        blocks.append((start, end, match.group(1), "".join(lines[start:end])))
    return blocks


def remove_legacy_alt_icon_references(lines: list[str]) -> tuple[list[str], int]:
    """Remove old AltIcons/AppIconPlugin objects and every reference to them."""
    blocks = _object_blocks(lines)
    legacy_ids = set()
    legacy_ranges = []

    for start, end, object_id, block_text in blocks:
        if any(pattern in block_text for pattern in LEGACY_ALT_ICON_PATTERNS):
            legacy_ids.add(object_id)
            legacy_ranges.append((start, end))

    # Also collect IDs from any matching lines. This catches child/build-phase
    # references when the matching object was formatted unusually.
    for line in lines:
        if any(pattern in line for pattern in LEGACY_ALT_ICON_PATTERNS):
            legacy_ids.update(PBX_ID_RE.findall(line))

    removed_indexes = set()
    for start, end in legacy_ranges:
        removed_indexes.update(range(start, end))

    cleaned = []
    removed = 0
    for idx, line in enumerate(lines):
        should_remove = idx in removed_indexes
        if not should_remove and any(pattern in line for pattern in LEGACY_ALT_ICON_PATTERNS):
            should_remove = True
        if not should_remove and legacy_ids and any(object_id in line for object_id in legacy_ids):
            should_remove = True

        if should_remove:
            removed += 1
        else:
            cleaned.append(line)

    return cleaned, removed


def ensure_entries_after_anchor(lines: list[str], section_name: str, anchor_line: str, entries: list[str]) -> list[str]:
    """Insert any `entries` not already present, directly after the line matching anchor_line."""
    missing = [e for e in entries if not any(e.strip() == l.strip() for l in lines)]
    if not missing:
        return lines

    anchor_idx = None
    for i, line in enumerate(lines):
        if line.strip() == anchor_line.strip():
            anchor_idx = i
            break

    if anchor_idx is None:
        print(f"  ERROR: anchor not found for {section_name}: '{anchor_line.strip()[:80]}'")
        sys.exit(1)

    for offset, entry in enumerate(missing):
        lines.insert(anchor_idx + 1 + offset, entry + "\n")

    print(f"  {section_name}: inserted {len(missing)} missing line(s)")
    return lines


def main():
    pbxproj = os.path.abspath(PBXPROJ)
    if not os.path.exists(pbxproj):
        print(f"ERROR: pbxproj not found at {pbxproj}")
        sys.exit(1)

    with open(pbxproj, "r", encoding="utf-8") as f:
        lines = f.readlines()

    original_count = len(lines)

    lines, legacy_removed = remove_legacy_alt_icon_references(lines)
    if legacy_removed:
        print(f"  Legacy alternate icons: removed {legacy_removed} stale line(s)")

    for section_name, anchor_line, entries in SECTIONS:
        lines = ensure_entries_after_anchor(lines, section_name, anchor_line, entries)

    with open(pbxproj, "w", encoding="utf-8") as f:
        f.writelines(lines)

    net_change = len(lines) - original_count
    print(f"pbxproj restored — net line change: {net_change:+d}")

    content = "".join(lines)

    # Final check 1: every required line must be present verbatim.
    content_lines = [l.strip() for l in lines]
    missing_after = [req for req in REQUIRED_LINES if req.strip() not in content_lines]
    if missing_after:
        print("ERROR: the following required lines are still missing after restore:")
        for line in missing_after:
            print(f"   - {line.strip()[:100]}")
        sys.exit(1)

    # Final check 2: legacy alternate-icon references must be completely gone.
    stale_patterns = [p for p in LEGACY_ALT_ICON_PATTERNS if p in content]
    if stale_patterns:
        print("ERROR: stale alternate-icon references remain in project.pbxproj:")
        for pattern in stale_patterns:
            print(f"   - {pattern}")
        sys.exit(1)

    # Final check 3: real structural validation via a minimal OpenStep-plist
    # parser (see validate_pbxproj.py). This is what actually catches the bug
    # class described above — a line sitting outside its enclosing {} or ()
    # — which a brace/paren-count check cannot: a misplaced-but-balanced
    # insertion still has equal counts of "{" and "}".
    try:
        validate_text(content)
    except ParseError as e:
        print(f"ERROR: pbxproj is not structurally valid after restore: {e}")
        sys.exit(1)

    for plugin in ("CameraOvalPlugin", "ScreenshotPlugin"):
        count = content.count(plugin)
        print(f"   {plugin}: {count} references")

    print("All custom plugins verified in pbxproj (lines present, structure validated)")


if __name__ == "__main__":
    main()
