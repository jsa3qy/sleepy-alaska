#!/usr/bin/env python3
"""
Add a pin to pins.yaml from a Google Maps or Apple Maps URL.
Usage: python add-pin.py <maps-url>
"""

import sys
import re
import urllib.request
import urllib.parse
from html.parser import HTMLParser
import yaml


class MapsParser(HTMLParser):
    """Parse Maps HTML to extract place information."""

    def __init__(self):
        super().__init__()
        self.title = None
        self.description = None

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)

        # Extract title from meta tags
        if tag == 'meta' and attrs_dict.get('property') == 'og:title':
            self.title = attrs_dict.get('content', '').strip()

        # Extract description from meta tags
        if tag == 'meta' and attrs_dict.get('property') == 'og:description':
            self.description = attrs_dict.get('content', '').strip()


def detect_maps_service(url):
    """Detect if URL is from Google Maps, Apple Maps, or AllTrails."""
    if 'maps.google.com' in url or 'maps.app.goo.gl' in url or 'goo.gl/maps' in url:
        return 'google'
    elif 'maps.apple.com' in url:
        return 'apple'
    elif 'alltrails.com' in url:
        return 'alltrails'
    else:
        return None


def fetch_apple_maps_data(url):
    """Fetch and parse Apple Maps URL."""

    # Parse URL to extract query parameters
    parsed = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qs(parsed.query)

    coordinates = None
    name = None
    description = None

    # Extract coordinates from ll parameter (latitude,longitude)
    if 'll' in params:
        ll = params['ll'][0]
        coords_match = re.match(r'(-?\d+\.\d+),(-?\d+\.\d+)', ll)
        if coords_match:
            lat = float(coords_match.group(1))
            lng = float(coords_match.group(2))
            coordinates = [lat, lng]

    # Extract name from q parameter (query/place name)
    if 'q' in params:
        name = urllib.parse.unquote_plus(params['q'][0])
        description = name  # Use name as description for Apple Maps

    # Extract address if available
    if 'address' in params:
        addr = urllib.parse.unquote_plus(params['address'][0])
        if not name:
            name = addr
        if not description:
            description = addr

    # If we still don't have coordinates, try to fetch from the page
    if not coordinates:
        try:
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req) as response:
                html = response.read().decode('utf-8')

                # Try to extract coordinates from Apple Maps HTML/JSON
                coords_match = re.search(r'"latitude":(-?\d+\.\d+),"longitude":(-?\d+\.\d+)', html)
                if coords_match:
                    lat = float(coords_match.group(1))
                    lng = float(coords_match.group(2))
                    coordinates = [lat, lng]
        except Exception as e:
            print(f"Warning: Could not fetch additional data from Apple Maps: {e}")

    return {
        'coordinates': coordinates,
        'name': name,
        'description': description,
        'url': url
    }


def fetch_alltrails_manual(url):
    """Manually input AllTrails data when auto-fetch fails."""

    print("\nEnter trail information:")
    name = input("Trail name: ").strip()

    while True:
        lat_str = input("Latitude (e.g., 61.1796): ").strip()
        lng_str = input("Longitude (e.g., -149.8353): ").strip()
        try:
            lat = float(lat_str)
            lng = float(lng_str)
            coordinates = [lat, lng]
            break
        except ValueError:
            print("Invalid coordinates. Please enter valid numbers.")

    distance = input("Distance in miles (e.g., 3.5): ").strip()
    elevation = input("Elevation gain in feet (e.g., 1350): ").strip()

    # Build description
    description_parts = []
    if distance:
        description_parts.append(f"{distance} mi")
    if elevation:
        description_parts.append(f"+{elevation} ft elevation")

    description = " • ".join(description_parts) if description_parts else "Hiking trail"

    return {
        'coordinates': coordinates,
        'name': name,
        'description': description,
        'url': url,
        'category': 'Hike'
    }


def fetch_alltrails_data(url):
    """Fetch and parse AllTrails URL."""

    # Convert regular AllTrails URL to widget URL (less restrictive)
    # Example: https://www.alltrails.com/trail/us/alaska/flattop-mountain
    # Becomes: https://www.alltrails.com/widget/trail/us/alaska/flattop-mountain
    widget_url = url.replace('alltrails.com/trail/', 'alltrails.com/widget/trail/')

    # If it's already a widget URL or doesn't match pattern, use as-is
    if 'widget' not in widget_url:
        widget_url = url

    try:
        req = urllib.request.Request(
            widget_url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://www.alltrails.com/'
            }
        )
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
    except Exception as e:
        print(f"\nWarning: Could not auto-fetch data from AllTrails ({e})")
        print("AllTrails blocks automated access. Please enter the trail details manually:")
        return fetch_alltrails_manual(url)

    coordinates = None
    name = None
    distance = None
    elevation_gain = None

    # Extract trail name from multiple sources
    # Try meta tags first (most reliable for widgets)
    meta_title = re.search(r'<meta property="og:title" content="([^"]+)"', html)
    if meta_title:
        name = meta_title.group(1)
        # Clean up: "Trail Name - State | AllTrails" -> "Trail Name"
        name = re.sub(r'\s*[-|].*$', '', name).strip()

    # Try page title as fallback
    if not name:
        title_match = re.search(r'<title>([^<]+)</title>', html)
        if title_match:
            title = title_match.group(1)
            name = re.sub(r'\s*[-|].*$', '', title).strip()

    # Try data attributes
    if not name or name == 'AllTrails':
        name_match = re.search(r'data-name="([^"]+)"', html)
        if name_match:
            name = name_match.group(1)

    # Last resort: extract from URL
    if not name or name == 'AllTrails':
        url_name = url.rstrip('/').split('/')[-1]
        name = url_name.replace('-', ' ').title()

    # Pattern 2: Look for coordinates in various formats
    coords_patterns = [
        r'"lat":([0-9.-]+),"lng":([0-9.-]+)',
        r'"latitude":([0-9.-]+),"longitude":([0-9.-]+)',
        r'data-lat="([0-9.-]+)"\s+data-lng="([0-9.-]+)"',
        r'center:\s*\[([0-9.-]+),\s*([0-9.-]+)\]',
    ]

    for pattern in coords_patterns:
        coords_match = re.search(pattern, html)
        if coords_match:
            lat = float(coords_match.group(1))
            lng = float(coords_match.group(2))
            coordinates = [lat, lng]
            break

    # Try to find coordinates in JSON-LD structured data
    if not coordinates:
        jsonld_match = re.search(r'<script type="application/ld\+json">([^<]+)</script>', html)
        if jsonld_match:
            try:
                import json
                data = json.loads(jsonld_match.group(1))
                if isinstance(data, list):
                    data = data[0]

                # Look for geo coordinates
                if 'geo' in data and isinstance(data['geo'], dict):
                    lat = data['geo'].get('latitude')
                    lng = data['geo'].get('longitude')
                    if lat and lng:
                        coordinates = [float(lat), float(lng)]
            except:
                pass

    # Extract distance/length - try multiple patterns
    # AllTrails stores distance in meters
    distance_patterns = [
        r'"length":([0-9.]+)',
        r'data-length="([0-9.]+)"',
    ]

    for pattern in distance_patterns:
        distance_match = re.search(pattern, html)
        if distance_match:
            meters = float(distance_match.group(1))
            miles = meters * 0.000621371
            distance = f"{miles:.1f} mi"
            break

    # Extract elevation gain - try multiple patterns
    # AllTrails stores elevation in meters, always convert to feet
    elevation_patterns = [
        r'"elevationGain":([0-9.]+)',
        r'data-elevation="([0-9.]+)"',
    ]

    for pattern in elevation_patterns:
        elevation_match = re.search(pattern, html)
        if elevation_match:
            meters = float(elevation_match.group(1))
            feet = meters * 3.28084
            elevation_gain = f"{int(feet)} ft"
            break

    # Build description
    description_parts = []
    if distance:
        description_parts.append(distance)
    if elevation_gain:
        description_parts.append(f"+{elevation_gain} elevation")

    description = " • ".join(description_parts) if description_parts else "Hiking trail"

    return {
        'coordinates': coordinates,
        'name': name,
        'description': description,
        'url': url,
        'category': 'Hike'  # AllTrails is always hiking
    }


def fetch_google_maps_data(url):
    """Fetch and parse Google Maps URL."""

    # Follow redirects to get the actual URL with coordinates
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0'}
    )

    try:
        with urllib.request.urlopen(req) as response:
            final_url = response.geturl()
            html = response.read().decode('utf-8')
    except Exception as e:
        print(f"Error fetching URL: {e}")
        return None

    # Extract coordinates from URL
    # Priority 1: Actual place coordinates (3d=lat, 4d=lng format)
    # This is the true location of the place, not just the map viewport
    place_coords = re.search(r'!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)', final_url)

    if place_coords:
        lat = float(place_coords.group(1))
        lng = float(place_coords.group(2))
        coordinates = [lat, lng]
    else:
        # Fallback: Map viewport center (@latitude,longitude,zoom)
        coords_match = re.search(r'@(-?\d+\.\d+),(-?\d+\.\d+)', final_url)

        # Alternative: coordinates in query params
        if not coords_match:
            coords_match = re.search(r'[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)', final_url)

        if not coords_match:
            # Try to extract from the HTML directly
            coords_match = re.search(r'"center":\{"lat":(-?\d+\.\d+),"lng":(-?\d+\.\d+)}', html)

        coordinates = None
        if coords_match:
            lat = float(coords_match.group(1))
            lng = float(coords_match.group(2))
            coordinates = [lat, lng]

    # Parse HTML for metadata
    parser = MapsParser()
    parser.feed(html)

    return {
        'coordinates': coordinates,
        'name': parser.title,
        'description': parser.description,
        'url': final_url if '://' in final_url else url
    }


def load_pins_yaml(filepath='public/pins.yaml'):
    """Load existing pins.yaml file."""
    try:
        with open(filepath, 'r') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        print(f"Error: {filepath} not found")
        sys.exit(1)


def save_pins_yaml(data, filepath='public/pins.yaml'):
    """Save updated pins.yaml file."""
    with open(filepath, 'w') as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)


def infer_category(name, description, categories):
    """Attempt to infer category based on keywords."""
    text = f"{name} {description}".lower()

    # Define keywords for each category
    keywords = {
        'Eat/Drink': ['restaurant', 'cafe', 'coffee', 'bar', 'food', 'burrito', 'pizza', 'brewery', 'bistro', 'diner'],
        'Hike': ['trail', 'hike', 'hiking', 'mountain', 'summit', 'trek'],
        'City': ['city', 'town', 'downtown', 'urban'],
        'Landmark': ['monument', 'historic', 'building', 'tower', 'statue', 'memorial'],
        'Point of Interest': ['park', 'museum', 'attraction', 'viewpoint', 'scenic']
    }

    # Check each category
    for category in categories:
        cat_name = category['name']
        if cat_name in keywords:
            for keyword in keywords[cat_name]:
                if keyword in text:
                    return cat_name

    return None


def process_single_url(url, pins_data):
    """Process a single URL and add it to the pins data."""

    # Detect which service
    service = detect_maps_service(url)

    if service == 'google':
        print(f"Fetching data from Google Maps...")
        data = fetch_google_maps_data(url)
    elif service == 'apple':
        print(f"Fetching data from Apple Maps...")
        data = fetch_apple_maps_data(url)
    elif service == 'alltrails':
        print(f"Fetching data from AllTrails...")
        data = fetch_alltrails_data(url)
    else:
        print("Error: URL not recognized")
        print("Supported formats:")
        print("  - Google Maps: https://maps.google.com/... or https://maps.app.goo.gl/...")
        print("  - Apple Maps: https://maps.apple.com/...")
        print("  - AllTrails: https://www.alltrails.com/trail/...")
        sys.exit(1)

    if not data:
        print("Failed to fetch data from URL")
        sys.exit(1)

    if not data['coordinates']:
        print("Could not extract coordinates from URL")
        sys.exit(1)

    print(f"\nFound place: {data['name']}")
    print(f"Coordinates: {data['coordinates']}")
    print(f"Description: {data['description']}")

    # Get categories from existing pins data
    categories = pins_data.get('categories', [])

    # Handle AllTrails differently - category is pre-set
    if service == 'alltrails':
        category = data.get('category', 'Hike')
        print(f"Category: {category} (auto-assigned for AllTrails)")

        # Prompt for custom description (optional)
        print(f"\nCurrent description: {data['description']}")
        custom_desc = input("Enter custom description (or press Enter to keep current): ").strip()
        if custom_desc:
            description = custom_desc
        else:
            description = data['description'] or data['name']

        # Create new pin entry for AllTrails
        new_pin = {
            'name': data['name'],
            'coordinates': data['coordinates'],
            'description': description,
            'category': category,
            'link': url  # AllTrails URL goes in "Learn more" link
        }

    else:
        # For maps services (Google/Apple Maps)
        # Try to infer category
        suggested_category = infer_category(data['name'] or '', data['description'] or '', categories)

        # Prompt for category
        print("\nAvailable categories:")
        for i, cat in enumerate(categories, 1):
            marker = " (suggested)" if cat['name'] == suggested_category else ""
            print(f"{i}. {cat['name']}{marker}")

        while True:
            choice = input(f"\nSelect category (1-{len(categories)}): ").strip()
            try:
                idx = int(choice) - 1
                if 0 <= idx < len(categories):
                    category = categories[idx]['name']
                    break
            except ValueError:
                pass
            print("Invalid choice. Try again.")

        # Prompt for custom description (optional)
        print(f"\nCurrent description: {data['description']}")
        custom_desc = input("Enter custom description (or press Enter to keep current): ").strip()
        if custom_desc:
            description = custom_desc
        else:
            description = data['description'] or data['name']

        # Prompt for optional "Learn more" link
        print(f"\nOptional: Add a 'Learn more' link (e.g., Wikipedia, website)")
        learn_more_link = input("Enter URL (or press Enter to skip): ").strip()

        # Create new pin entry for maps
        new_pin = {
            'name': data['name'],
            'coordinates': data['coordinates'],
            'description': description,
            'category': category,
            'maps_link': url
        }

        # Add optional learn more link
        if learn_more_link:
            new_pin['link'] = learn_more_link

    # Add to pins list
    pins_data['pins'].append(new_pin)

    print(f"✓ Successfully added '{data['name']}' to pins.yaml!")
    print(f"  Category: {category}")
    print(f"  Coordinates: {data['coordinates']}")

    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: python add-pin.py <url-or-file>")
        print("  Single URL: python add-pin.py <url>")
        print("  Batch file: python add-pin.py urls.txt")
        print("\nSupports: Google Maps, Apple Maps, or AllTrails URLs")
        sys.exit(1)

    input_arg = sys.argv[1]

    # Check if input is a file
    import os
    if os.path.isfile(input_arg):
        # Batch mode - process URLs from file
        print(f"Batch mode: Reading URLs from {input_arg}\n")

        with open(input_arg, 'r') as f:
            urls = [line.strip() for line in f if line.strip() and not line.strip().startswith('#')]

        if not urls:
            print("Error: No URLs found in file")
            sys.exit(1)

        print(f"Found {len(urls)} URL(s) to process\n")

        # Load pins.yaml once at the start
        pins_data = load_pins_yaml()

        success_count = 0
        for i, url in enumerate(urls, 1):
            print(f"\n{'='*60}")
            print(f"Processing {i}/{len(urls)}: {url}")
            print('='*60)

            try:
                if process_single_url(url, pins_data):
                    success_count += 1
            except KeyboardInterrupt:
                print("\n\nBatch processing interrupted by user.")
                print(f"Processed {success_count}/{i} URLs successfully.")

                # Ask if they want to save what was added so far
                save_response = input("\nSave pins added so far? (y/n): ").strip().lower()
                if save_response == 'y':
                    save_pins_yaml(pins_data)
                    print(f"Saved {success_count} pin(s) to pins.yaml")
                sys.exit(0)
            except Exception as e:
                print(f"\n✗ Error processing {url}: {e}")
                continue_response = input("Continue to next URL? (y/n): ").strip().lower()
                if continue_response != 'y':
                    break

        # Save all changes at the end
        save_pins_yaml(pins_data)
        print(f"\n{'='*60}")
        print(f"Batch complete: {success_count}/{len(urls)} URLs processed successfully")
        print(f"{'='*60}")

    else:
        # Single URL mode
        url = input_arg

        # Load pins.yaml
        pins_data = load_pins_yaml()

        # Process the single URL
        if process_single_url(url, pins_data):
            # Save updated YAML
            save_pins_yaml(pins_data)


if __name__ == '__main__':
    main()
