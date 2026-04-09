export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const playersParam = req.query.players || "";
    const players = playersParam
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    if (!players.length) {
      return res.status(400).json({ error: "No players provided" });
    }

    if (!process.env.HENRIK_API_KEY) {
      return res.status(500).json({ error: "Missing HENRIK_API_KEY" });
    }

    const headers = {
      Authorization: process.env.HENRIK_API_KEY,
      Accept: "application/json",
    };

    const results = [];

    for (const entry of players) {
      const [name, tag] = (entry || "").split("#");

      if (!name || !tag) {
        results.push({
          riotId: entry,
          seasonLabel: "Current Act",
          kd: 0,
          kda: "0 / 0 / 0",
          hs: 0,
          firstKills: 0,
          firstDeaths: 0,
          agents: [],
          error: "Invalid Riot ID format",
        });
        continue;
      }

      try {
        const accountRes = await fetch(
          `https://api.henrikdev.xyz/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
          { headers }
        );

        if (!accountRes.ok) {
          const errorText = await accountRes.text();
          results.push({
            riotId: `${name}#${tag}`,
            seasonLabel: "Current Act",
            kd: 0,
            kda: "0 / 0 / 0",
            hs: 0,
            firstKills: 0,
            firstDeaths: 0,
            agents: [],
            error: `Account lookup failed (${accountRes.status}): ${errorText}`,
          });
          continue;
        }

        const accountJson = await accountRes.json();

        const canonicalName = accountJson?.data?.name || name;
        const canonicalTag = accountJson?.data?.tag || tag;
        const region =
          (accountJson?.data?.region || accountJson?.data?.account_region || "eu").toLowerCase();

        const matchesRes = await fetch(
          `https://api.henrikdev.xyz/valorant/v4/matches/${encodeURIComponent(region)}/pc/${encodeURIComponent(canonicalName)}/${encodeURIComponent(canonicalTag)}?mode=competitive&size=10`,
          { headers }
        );

        if (!matchesRes.ok) {
          const errorText = await matchesRes.text();
          results.push({
            riotId: `${canonicalName}#${canonicalTag}`,
            seasonLabel: "Current Act",
            kd: 0,
            kda: "0 / 0 / 0",
            hs: 0,
            firstKills: 0,
            firstDeaths: 0,
            agents: [],
            error: `Match request failed (${matchesRes.status}): ${errorText}`,
          });
          continue;
        }

        const matchesJson = await matchesRes.json();
        const matches = Array.isArray(matchesJson?.data) ? matchesJson.data : [];

        if (!matches.length) {
          results.push({
            riotId: `${canonicalName}#${canonicalTag}`,
            seasonLabel: "Current Act",
            kd: 0,
            kda: "0 / 0 / 0",
            hs: 0,
            firstKills: 0,
            firstDeaths: 0,
            agents: [],
          });
          continue;
        }

        const currentSeasonId =
          matches[0]?.metadata?.season_id ||
          matches[0]?.meta?.season_id ||
          null;

        const actMatches = currentSeasonId
          ? matches.filter((m) => {
              const sid = m?.metadata?.season_id || m?.meta?.season_id || null;
              return sid === currentSeasonId;
            })
          : matches;

        let totalKills = 0;
        let totalDeaths = 0;
        let totalAssists = 0;
        let totalHeadshots = 0;
        let totalBodyshots = 0;
        let totalLegshots = 0;
        let totalFirstKills = 0;
        let totalFirstDeaths = 0;
        const agentCounts = {};

        for (const match of actMatches) {
          const allPlayers =
            match?.players?.all_players ||
            match?.players ||
            [];

          const me =
            allPlayers.find(
              (p) =>
                String(p?.name || "").toLowerCase() === canonicalName.toLowerCase() &&
                String(p?.tag || "").toLowerCase() === canonicalTag.toLowerCase()
            ) ||
            allPlayers.find(
              (p) =>
                String(p?.name || "").toLowerCase() === name.toLowerCase() &&
                String(p?.tag || "").toLowerCase() === tag.toLowerCase()
            );

          if (!me) continue;

          const stats = me?.stats || {};

          totalKills += Number(stats.kills || 0);
          totalDeaths += Number(stats.deaths || 0);
          totalAssists += Number(stats.assists || 0);
          totalHeadshots += Number(stats.headshots || 0);
          totalBodyshots += Number(stats.bodyshots || 0);
          totalLegshots += Number(stats.legshots || 0);

          totalFirstKills += Number(stats.firstkills ?? stats.first_kills ?? 0);
          totalFirstDeaths += Number(stats.firstdeaths ?? stats.first_deaths ?? 0);

          const agent = me?.character || me?.agent?.name || null;
          if (agent) {
            agentCounts[agent] = (agentCounts[agent] || 0) + 1;
          }
        }

        const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
        const hs =
          totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;

        const kd =
          totalDeaths > 0
            ? Number((totalKills / totalDeaths).toFixed(2))
            : Number(totalKills.toFixed(2));

        const agents = Object.entries(agentCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([agent]) => agent)
          .slice(0, 3);

        results.push({
          riotId: `${canonicalName}#${canonicalTag}`,
          seasonLabel: "Current Act",
          kd,
          kda: `${totalKills} / ${totalDeaths} / ${totalAssists}`,
          hs,
          firstKills: totalFirstKills,
          firstDeaths: totalFirstDeaths,
          agents,
        });
      } catch (playerError) {
        results.push({
          riotId: `${name}#${tag}`,
          seasonLabel: "Current Act",
          kd: 0,
          kda: "0 / 0 / 0",
          hs: 0,
          firstKills: 0,
          firstDeaths: 0,
          agents: [],
          error: String(playerError),
        });
      }
    }

    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: String(error),
    });
  }
}
