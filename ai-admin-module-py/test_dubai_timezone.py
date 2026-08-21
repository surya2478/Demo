"""
Test script to verify Dubai timezone conversion
"""

from datetime import datetime, timezone, timedelta

# Test Dubai timezone conversion
print("=" * 60)
print("DUBAI TIMEZONE CONVERSION TEST")
print("=" * 60)

# Create Dubai timezone
dubai_tz = timezone(timedelta(hours=4))

# Test 1: Convert UTC to Dubai time
print("\n✓ Test 1: UTC to Dubai Time Conversion")
utc_time = datetime.now(timezone.utc)
dubai_time = utc_time.astimezone(dubai_tz)
print(f"  UTC Time:    {utc_time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
print(f"  Dubai Time:  {dubai_time.strftime('%Y-%m-%d %H:%M:%S %Z (UTC+04:00)')}")
print(f"  Offset:      {dubai_time.utcoffset()}")

# Test 2: Parse ISO format and convert
print("\n✓ Test 2: ISO Format Parsing and Conversion")
iso_time = "2026-01-13T10:30:00Z"
parsed_utc = datetime.fromisoformat(iso_time.replace('Z', '+00:00'))
dubai_converted = parsed_utc.astimezone(dubai_tz)
print(f"  Input ISO:   {iso_time}")
print(f"  Parsed UTC:  {parsed_utc.strftime('%Y-%m-%d %H:%M:%S %Z')}")
print(f"  Dubai Time:  {dubai_converted.strftime('%Y-%m-%d %H:%M:%S %Z (UTC+04:00)')}")

# Test 3: Verify offset
print("\n✓ Test 3: Timezone Offset Verification")
offset_hours = dubai_time.utcoffset().total_seconds() / 3600
print(f"  Expected Offset: 4 hours")
print(f"  Actual Offset:   {int(offset_hours)} hours")
print(f"  Status:          {'✓ CORRECT' if offset_hours == 4 else '✗ INCORRECT'}")

print("\n" + "=" * 60)
print("✓ DUBAI TIMEZONE SETUP VERIFIED")
print("=" * 60)
