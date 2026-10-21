# Kibera News

A website that tracks news about Kibera, Nairobi. A collector searches the web every three
hours, and the site shows every story it finds with a date and time, grouped by day, with
filters.

## How it works

```
GitHub Actions (every 3 h) ──► scraper/collect.py ──► data/news.json ──► index.html + js/app.js
```

1. **Collect.** `.github/workflows/collect-news.yml` runs `scraper/collect.py` on a schedule
   (`17 */3 * * *` UTC). You can also run it by hand from the Actions tab (*Run workflow*).
2. **Sources** (all listed in `scraper/sources.json`, which you can edit):
   - **News search:** Google News (English and Swahili), Bing News and the
     [GDELT](https://www.gdeltproject.org/) global news API. These all search for "Kibera" or "Kibra".
   - **Kenyan outlets:** RSS feeds from The Star, Capital FM, Kenyans.co.ke, Tuko, Citizen
     Digital, The Standard, Nation, KBC and Ghetto Radio. Only stories that mention Kibera or
     Kibra in the headline or summary are kept.
3. **Process.** Each story gets a UTC timestamp. Duplicates are merged: the same story found
   through Google and the outlet's own feed shows once, with the direct link. Each story also
   gets a topic assigned by keyword. The collector keeps one year of history and saves it to
   `data/news.json`, which the workflow commits back to the repo.
4. **Display.** The static site reads `data/news.json`. It checks for new stories every 5 minutes
   and shows a "new stories" button when there are some.

If one source fails, for example a blocked feed or a timeout, the collector logs it and carries
on with the rest. The site footer shows how each source did on the last run. If every source
fails, the existing file is left unchanged.

## Features

- **Live clock** in Nairobi time (EAT), plus when the news was last collected ("Updated 47 min ago · …").
- **Day-by-day feed** with headings such as *Today · Wednesday 21 October 2026*. Each story shows
  its time ("17:35 EAT"), how long ago it was published, a topic label, the headline linking to
  the original article, a summary when the source gives one, and the publisher.
- **Date and time format options:**
  - Time zone: Nairobi (EAT), your own time zone, or UTC.
  - Clock: 24-hour or 12-hour.
  - Dates: `Wednesday 21 October 2026`, `Wed 21 Oct 2026` or `2026-10-21`.
- **Filters:**
  - Search across headlines and summaries.
  - Period: Today, 24 hours, 7 days, 30 days, All, or a custom from/to range.
  - Topic, with a live count for each. Click a story's label to show only that topic.
  - Source and sort order.
- **Shareable views.** Every filter and format setting is saved in the URL, for example
  `?period=today&cats=Health`.
- Works on phones, where the filters fold into a panel.

Topics: Fire & Emergencies, Crime & Security, Housing & Land, Health, Water & Sanitation,
Education, Politics & Governance, Business & Jobs, Sports, Arts & Culture, Infrastructure &
Transport, Community & Development, and General. The keyword rules are in `CATEGORIES` in
`scraper/collect.py`, and the first matching rule wins.

## Run locally

```sh
python3 scraper/collect.py        # fetch the latest news (needs internet)
python3 -m http.server 8000       # then open http://localhost:8000
python3 -m unittest discover -s tests   # collector tests (offline)
```

There is no build step and nothing to install: the collector uses only the Python standard library.

## Publish

1. **Website:** go to Settings → Pages → *Deploy from a branch*, then choose this branch and `/ (root)`.
2. **Collector:** go to Settings → Actions → General → *Workflow permissions*, choose
   **Read and write**, and save. This lets the workflow commit `data/news.json`.
3. Open the Actions tab → *Collect Kibera news* → *Run workflow* to fetch the first batch now.

GitHub runs scheduled workflows only on the repository's default branch, and may pause them after
60 days without any repository activity.

## Adding a source

Add an entry to `scraper/sources.json`:

- `outlets` for a publisher's RSS or Atom feed. Its stories are filtered by the `keywords`.
- `search` for a feed that already returns only Kibera results.

## Notes

- Headlines and summaries belong to their publishers. The site shows only short summaries and
  always links to the original article.
- Topics are assigned automatically and will sometimes be wrong.
- Google News links go through a Google redirect. When the same story also appears in an outlet
  feed, GDELT or Bing, the direct link is used instead.
