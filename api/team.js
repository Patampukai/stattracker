export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const playersParam = req.query.players || "";
    const players = playersParam.split(",").map(p => p.trim()).filter(Boolean);

    if (!process.env.TRN_API_KEY) {
      return res.status(500).json({ error: "Missing TRN_API_KEY" });
    }

    const results = [];

    for (const entry of players) {
      const [name, tag] = entry.split("#");

      try {
        const url = `https://public-api.tracker.gg/v2/valorant/standard/profile/riot/${encodeURIComponent(name)}%23${encodeURIComponent(tag)}`;

        const response = await fetch(url, {
          headers: {
            "TRN-Api-Key": process.env.TRN_API_KEY
          }
        });

        const json = await response.json();

        if (!response.ok) {
          results.push({
            riotId: entry,
            error: json?.errors?.[0]?.message || "API error"
          });
          continue;
        }

        const segments = json?.data?.segments || [];

        const overview = segments.find(s => s.type === "overview");
        const stats = overview?.stats || {};

        const competitive = segments.find(s => s.type === "competitive");

        const get = key => stats[key]?.displayValue || 0;

        results.push({
          riotId: entry,
          seasonLabel: "Tracker",

          kda: `${get("kills")} / ${get("deaths")} / ${get("assists")}`,
          kd: parseFloat(stats?.kd?.value || 0).toFixed(2),
          hs: get("headshotPct"),

          rank:
            competitive?.stats?.tier?.displayValue ||
            competitive?.stats?.rank?.metadata?.tierName ||
            "Unranked",

          rr:
            competitive?.stats?.rankingScore?.displayValue ||
            0
        });

      } catch (err) {
        results.push({
          riotId: entry,
          error: String(err)
        });
      }
    }

    res.status(200).json(results);

  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
}
