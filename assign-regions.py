#!/usr/bin/env python3
"""
Assign regions to existing pins based on their coordinates.
Usage: python assign-regions.py

Loads configuration from .env file in the same directory.

Region boundaries:
  - North of Anchorage: lat > 61.45 (Palmer, Wasilla, Talkeetna, Denali)
  - Anchorage Area: 60.7 < lat <= 61.45 (includes Girdwood at ~60.94)
  - Seward Area: lat <= 60.7 AND lng > -150.3 (eastern Kenai Peninsula)
  - Kenai Peninsula: lat <= 60.7 AND lng <= -150.3 (Homer, Soldotna, Kenai)
"""

import os
import sys
from pathlib import Path


def load_env():
    """Load environment variables from .env file."""
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ.setdefault(key.strip(), value.strip())


def get_supabase():
    """Get Supabase client."""
    load_env()

    try:
        from supabase import create_client

        # Try VITE_ prefixed vars first (from .env), then fall back to non-prefixed
        url = os.environ.get("VITE_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("VITE_SUPABASE_ANON_KEY")

        if not url or not key:
            print("Error: Could not find Supabase credentials in .env file")
            print("Expected: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY)")
            sys.exit(1)

        print(f"Connecting to: {url}")
        return create_client(url, key)
    except ImportError:
        print("Error: supabase package not installed. Run: pip install supabase")
        sys.exit(1)


def determine_region(lat: float, lng: float) -> str:
    """
    Determine region name based on coordinates.

    Boundaries:
    - North of Anchorage: lat > 61.45
    - Anchorage Area: 60.7 < lat <= 61.45
    - Seward Area: lat <= 60.7 AND lng > -150.3 (eastern peninsula)
    - Kenai Peninsula: lat <= 60.7 AND lng <= -150.3 (western peninsula)
    """
    if lat > 61.45:
        return "North of Anchorage"
    elif lat > 60.7:
        return "Anchorage Area"
    elif lng > -150.3:
        return "Seward Area"
    else:
        return "Kenai Peninsula"


def main():
    print("Assigning regions to pins based on coordinates...\n")

    supabase = get_supabase()

    # Fetch all regions
    print("Fetching regions...")
    regions_result = supabase.table("regions").select("*").execute()

    if not regions_result.data:
        print("ERROR: No regions found in database!")
        print("Please run the SQL migration first:")
        print("  supabase/migrations/20260106_add_voting_and_regions.sql")
        sys.exit(1)

    regions = {r["name"]: r["id"] for r in regions_result.data}
    print(f"Found {len(regions)} regions: {', '.join(regions.keys())}")

    # Fetch all pins
    print("\nFetching pins...")
    pins_result = supabase.table("pins").select("id, name, lat, lng, region_id").execute()
    pins = pins_result.data
    print(f"Found {len(pins)} pins")

    # Assign regions
    updates = []
    region_counts = {name: 0 for name in regions.keys()}

    print("\n" + "="*60)
    print("Region Assignments:")
    print("="*60)

    for pin in pins:
        region_name = determine_region(pin["lat"], pin["lng"])
        region_id = regions.get(region_name)

        if not region_id:
            print(f"Warning: Region '{region_name}' not found for pin '{pin['name']}'")
            continue

        # Only update if region changed
        if pin.get("region_id") != region_id:
            updates.append({
                "id": pin["id"],
                "region_id": region_id,
                "name": pin["name"],
                "region_name": region_name
            })

        region_counts[region_name] += 1
        print(f"  {pin['name']}: {region_name}")

    print("\n" + "="*60)
    print("Summary by Region:")
    print("="*60)
    for name, count in sorted(region_counts.items()):
        print(f"  {name}: {count} pins")

    if not updates:
        print("\nNo updates needed - all pins already have correct regions.")
        return

    print(f"\n{len(updates)} pins need region updates.")

    # Perform updates
    print("\nUpdating pins in database...")
    for update in updates:
        supabase.table("pins").update({
            "region_id": update["region_id"]
        }).eq("id", update["id"]).execute()
        print(f"  Updated: {update['name']} -> {update['region_name']}")

    print(f"\n✓ Successfully assigned regions to {len(updates)} pins!")


if __name__ == "__main__":
    main()
