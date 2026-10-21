import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))
import collect as c  # noqa: E402

GOOGLE_RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Fire razes homes in Kibera's Laini Saba - The Star</title>
<link>https://news.google.com/rss/articles/abc?oc=5</link>
<pubDate>Tue, 20 Oct 2026 09:30:00 GMT</pubDate>
<description>&lt;a href="x"&gt;Fire razes homes in Kibera's Laini Saba&lt;/a&gt;</description>
<source url="https://www.the-star.co.ke">The Star</source></item>
</channel></rss>"""

OUTLET_RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Fire razes homes in Kibera's Laini Saba</title>
<link>https://www.the-star.co.ke/news/2026-10-20-fire-razes-homes/?utm_source=rss</link>
<pubDate>Tue, 20 Oct 2026 12:30:00 +0300</pubDate>
<description>&lt;p&gt;Dozens of families were left homeless.&lt;/p&gt;</description></item>
<item><title>Parliament passes finance bill</title>
<link>https://www.the-star.co.ke/news/finance</link>
<pubDate>Tue, 20 Oct 2026 10:00:00 +0300</pubDate><description>Nothing local.</description></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Kibra youth open recycling hub</title><link rel="alternate" href="https://example.org/hub"/>
<updated>2026-10-19T08:00:00Z</updated><summary>Young people in Kibra turn plastic into paving blocks.</summary></entry>
</feed>"""

GDELT = json.dumps({"articles": [
    {"url": "https://example.com/school", "title": "New school opens in Kibera", "seendate": "20261018T070000Z",
     "domain": "example.com", "language": "English"}]}).encode()


class CollectTests(unittest.TestCase):
    def test_google_title_and_summary_cleanup(self):
        item = c.fix_google(c.parse_feed(GOOGLE_RSS, "Google News")[0])
        self.assertEqual(item["title"], "Fire razes homes in Kibera's Laini Saba")
        self.assertEqual(item["publisher"], "The Star")
        self.assertEqual(item["summary"], "")

    def test_bing_link_unwrapped(self):
        item = c.fix_bing({"url": "http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fa.com%2fb&c=1"})
        self.assertEqual(item["url"], "https://a.com/b")

    def test_atom_and_gdelt(self):
        a = c.parse_feed(ATOM, "X")[0]
        self.assertEqual(a["url"], "https://example.org/hub")
        self.assertEqual(a["date"], datetime(2026, 10, 19, 8, tzinfo=timezone.utc))
        g = c.parse_gdelt(GDELT, "GDELT")[0]
        self.assertEqual(g["date"], datetime(2026, 10, 18, 7, tzinfo=timezone.utc))

    def test_categories(self):
        self.assertEqual(c.categorize("Fire razes homes in Kibera", ""), "Fire & Emergencies")
        self.assertEqual(c.categorize("Police arrest suspects in Kibera", ""), "Crime & Security")
        self.assertEqual(c.categorize("New school opens in Kibera", ""), "Education")
        self.assertEqual(c.categorize("Kibera residents speak", ""), "General")

    def test_merge_dedupes_and_prefers_direct_link(self):
        now = datetime(2026, 10, 21, tzinfo=timezone.utc)
        google = c.normalise(c.fix_google(c.parse_feed(GOOGLE_RSS, "Google News")[0]), now)
        outlet_raw = c.parse_feed(OUTLET_RSS, "The Star")
        kw = c.re.compile(r"\b(kibera|kibra)\b", c.re.I)
        outlet_raw = [i for i in outlet_raw if kw.search(i["title"] + i["summary"])]
        self.assertEqual(len(outlet_raw), 1)
        outlet = c.normalise(outlet_raw[0], now)
        merged = c.merge([google], [outlet], now)
        self.assertEqual(len(merged), 1)
        self.assertIn("the-star.co.ke", merged[0]["url"])
        self.assertEqual(merged[0]["summary"], "Dozens of families were left homeless.")

    def test_canonical_url_strips_tracking(self):
        self.assertEqual(c.canonical_url("http://www.a.com/x/?utm_source=rss&id=2"), "https://a.com/x?id=2")

    def test_future_dates_clamped(self):
        now = datetime(2026, 10, 21, tzinfo=timezone.utc)
        it = c.normalise({"title": "t", "url": "https://a/b", "summary": "", "publisher": "", "via": "v",
                          "date": datetime(2030, 1, 1, tzinfo=timezone.utc)}, now)
        self.assertEqual(it["published"], "2026-10-21T00:00:00Z")

    def test_sports_wins_over_politics_campaign(self):
        self.assertEqual(c.categorize("Coach explains poor start to league campaign", ""), "Sports")

    def test_msn_suffix_removed(self):
        self.assertEqual(c.clean_publisher("Tuko News on MSN"), "Tuko News")

    def test_bing_results_need_keyword(self):
        kw = c.re.compile(r"\b(kibera|kibra)\b", c.re.I)
        feed = b"""<rss><channel>
<item><title>Hippo pathway research</title><link>https://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fa.com%2f1</link><description>Biotech.</description></item>
<item><title>Kibera traders protest</title><link>https://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fa.com%2f2</link><description>x</description></item>
</channel></rss>"""
        orig = c.fetch
        c.fetch = lambda url, **kw_: feed
        try:
            _, items, err = c.collect_source({"name": "Bing News", "url": "https://www.bing.com/news/search?q=Kibera&format=rss",
                                              "filter_keywords": True}, kw, True)
        finally:
            c.fetch = orig
        self.assertIsNone(err)
        self.assertEqual([i["url"] for i in items], ["https://a.com/2"])


if __name__ == "__main__":
    unittest.main()
