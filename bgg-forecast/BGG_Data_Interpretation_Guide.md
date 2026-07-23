# How to Interpret BGG Forecast Data — Step-by-Step

**Model run used for these examples: 2026-07-20T00:00:00Z**

## Step 1: Understand what a band is
Each band is a **24-hour forecast window** ending at its valid time. So a band valid at `2026-07-24 00:00Z` represents data from `2026-07-23 00:00Z` to `2026-07-24 00:00Z`.

## Step 2: Know the DAY/NIGHT convention
- **DAY** = local time 7:00am–7:00pm
- **NIGHT** = local time 7:00pm–7:00am
- Only the portion of a band's 24-hour window that falls in the local day (or night) counts toward that file.

## Step 3: Convert the local DAY window to UTC for your target city
Take 7am–7pm **local time** for your target date and convert to UTC using that city's offset.

## Step 4: Find the band(s) whose 24-hour UTC window *fully contains* that converted DAY (or NIGHT) window
- If a UTC day boundary lines up cleanly with the local day boundary, **two adjacent bands** may both work.
- If the offset causes the local day to straddle a UTC boundary, **only one specific band** will be correct — using the other will silently pull in data from the wrong day.

## Step 5: Query that band's grid value for your variable (e.g., `bgg-global-day-temp-max-c-2meter`)

---

## Reference: Band Table for This Run (2026-07-20T00:00:00Z)

| Band | Lead | Valid time (UTC) |
|------|--------|------------------------|
| 1 | f+24h | Tue 2026-07-21 00:00Z |
| 2 | f+36h | Tue 2026-07-21 12:00Z |
| 3 | f+48h | Wed 2026-07-22 00:00Z |
| 4 | f+60h | Wed 2026-07-22 12:00Z |
| 5 | f+72h | Thu 2026-07-23 00:00Z |
| 6 | f+84h | Thu 2026-07-23 12:00Z |
| 7 | f+96h | Fri 2026-07-24 00:00Z |
| 8 | f+108h | Fri 2026-07-24 12:00Z |
| 9 | f+120h | Sat 2026-07-25 00:00Z |
| 10 | f+132h | Sat 2026-07-25 12:00Z |
| 11 | f+144h | Sun 2026-07-26 00:00Z |
| 12 | f+156h | Sun 2026-07-26 12:00Z |
| 13 | f+168h | Mon 2026-07-27 00:00Z |
| 14 | f+180h | Mon 2026-07-27 12:00Z |
| 15 | f+192h | Tue 2026-07-28 00:00Z |
| 16 | f+204h | Tue 2026-07-28 12:00Z |
| 17 | f+216h | Wed 2026-07-29 00:00Z |
| 18 | f+228h | Wed 2026-07-29 12:00Z |
| 19 | f+240h | Thu 2026-07-30 00:00Z |
| 20 | f+252h | Thu 2026-07-30 12:00Z |

---

## Worked Examples: Max DAY Temp for Thursday, July 23, 2026

| City | Local offset | Local DAY (7am–7pm) in UTC | Correct band(s) |
|------|------|------|------|
| **Chicago** (CDT, UTC−5) | −5h | Jul 23 12:00Z – Jul 24 00:00Z | **Either** Band 7 (f+96h, Fri Jul 24 00:00Z) **or** Band 8 (f+108h, Fri Jul 24 12:00Z) |
| **Berlin** (CEST, UTC+2) | +2h | Jul 23 05:00Z – 17:00Z | **Only** Band 7 (f+96h, Fri Jul 24 00:00Z) |
| **New Delhi** (IST, UTC+5:30) | +5:30h | Jul 23 01:30Z – 13:30Z | **Only** Band 7 (f+96h, Fri Jul 24 00:00Z) |
| **Jakarta** (WIB, UTC+7) | +7h | Jul 23 00:00Z – 12:00Z | **Either** Band 6 (f+84h, Thu Jul 23 12:00Z) **or** Band 7 (f+96h, Fri Jul 24 00:00Z) |
| **Tokyo** (JST, UTC+9) | +9h | Jul 22 22:00Z – Jul 23 10:00Z | **Only** Band 6 (f+84h, Thu Jul 23 12:00Z) |

**Why the difference?** Chicago and Jakarta each have an offset that lets their local DAY window sit fully inside two different 24-hour band windows — so either band gives the correct answer. Berlin, New Delhi, and Tokyo have offsets that cause their local DAY window to straddle a UTC boundary in a way that only one band fully captures — picking the "wrong" adjacent band would silently mix in part of the wrong calendar day.

## Bonus: NIGHT Example (Chicago, Night of July 23→24)
- Local NIGHT window: Jul 23 19:00 CDT – Jul 24 07:00 CDT = **Jul 24 00:00Z – 12:00Z**
- Correct band(s): **Either** Band 8 (f+108h, Fri Jul 24 12:00Z) **or** Band 9 (f+120h, Sat Jul 25 00:00Z)

---

**Bottom line:** there's no universal offset rule (like "always add 24h") — you have to convert the local day window to UTC for each city and check which band's 24-hour window fully contains it. Cities whose offset is a "nice" multiple relative to the 12-hour band grid get flexibility (either of two bands works); cities that don't align only have one correct band.
