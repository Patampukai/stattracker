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

    const pickNumber = (obj, keys) => {
      if (!obj) return 0;
      for (const key of keys) {
        const value = obj?.[key];
        if (typeof value === "number") return value;
        if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
          return Number(value);
        }
      }
      return 0;
    };

    const getAllPlayers = (match) => {
      if (Array.isArray(match?.players?.all_players)) return match.players.all_players;
      if (Array.isArray(match?.players)) return match.players;
      return [];
    };

    const getSeasonId = (match) =>
      match?.metadata?.season_id ||
      match?.meta?.season_id ||
      match?.season_id ||
      null;

    const getMe = (match, name, tag, canonicalName, canonicalTag) => {
      const allPlayers = getAllPlayers(match);

      return (
        allPlayers.find(
          (p) =>
            String(p?.name || "").toLowerCase() === canonicalName.toLowerCase() &&
            String(p?.tag || "").toLowerCase() === canonicalTag.toLowerCase()
        ) ||
        allPlayers.find(
          (p) =>
            String(p?.name || "").toLowerCase() === name.toLowerCase() &&
            String(p?.tag || "").toLowerCase() === tag.toLowerCase()
        ) ||
        null
      );
    };

    const getDamage = (player) => {
      const stats = player?.stats || {};
      const direct =
        pickNumber(stats, ["damage_made", "damage", "total_damage", "damage_dealt"]) ||
        pickNumber(player, ["damage_made", "damage", "total_damage", "damage_dealt"]);

      if (direct > 0) return direct;

      const damageEvents =
        player?.damage_made ||
        player?.damage ||
        player?.damage_events ||
        [];

      if (Array.isArray(damageEvents)) {
        return damageEvents.reduce(
          (sum, entry) => sum + pickNumber(entry, ["damage", "damage_made", "value", "amount"]),
          0
        );
      }

      return 0;
    };

    const getMultikills = (player) => {
      const stats = player?.stats || {};

      const explicitTotal =
        pickNumber(stats, ["multikills", "multi_kills", "multikill_rounds"]) ||
        pickNumber(player, ["multikills", "multi_kills", "multikill_rounds"]);

      if (explicitTotal > 0) return explicitTotal;

      const twoKs = pickNumber(stats, ["double_kills", "doubleKills", "kills_2", "two_kills"]);
      const threeKs = pickNumber(stats, ["triple_kills", "tripleKills", "kills_3", "three_kills"]);
      const fourKs = pickNumber(stats, ["quadra_kills", "quadraKills", "kills_4", "four_kills"]);
      const fiveKs = pickNumber(stats, ["penta_kills", "pentaKills", "kills_5", "five_kills"]);

      return twoKs + threeKs + fourKs + fiveKs;
    };

    const results = [];

    for (const entry of players) {
      const [name, tag] = String(entry).split("#");

      if (!name || !tag) {
        results.push({
          riotId: entry,
          seasonLabel: "Season 2026 // Act 2",
          matchesPlayed: 0,
          kd: 0,
          kda: "0 / 0 / 0",
          hs: 0,
          adr: 0,
          firstKills: 0,
          firstDeaths: 0,
          multikills: 0,
          agents: [],
          error: "Invalid Riot ID format",
        });
        continue;
      }

      try {
        // 1) Account lookup for canonical Riot ID + auto region detection
        const accountRes = await fetch(
          `https://api.henrikdev.xyz/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
          { headers }
        );

        if (!accountRes.ok) {
          const errorText = await accountRes.text();
          results.push({
            riotId: `${name}#${tag}`,
            seasonLabel: "Season 2026 // Act 2",
            matchesPlayed: 0,
            kd: 0,
            kda: "0 / 0 / 0",
            hs: 0,
            adr: 0,
            firstKills: 0,
            firstDeaths: 0,
            multikills: 0,
            agents: [],
            error: `Account lookup failed (${accountRes.status}): ${errorText}`,
          });
          continue;
        }

        const accountJson = await accountRes.json();
        const canonicalName = accountJson?.data?.name || name;
        const canonicalTag = accountJson?.data?.tag || tag;
        const region = String(accountJson?.data?.region || "eu").toLowerCase();

        // 2) Pull pages of competitive matches until season_id changes
        const collectedMatches = [];
        let start = 0;
        let currentSeasonId = null;
        let keepGoing = true;
        const MAX_PAGES = 6; // up to 60 matches

        for (let page = 0; page < MAX_PAGES && keepGoing; page += 1) {
          const matchesRes = await fetch(
            `https://api.henrikdev.xyz/valorant/v4/matches/${encodeURIComponent(region)}/pc/${encodeURIComponent(canonicalName)}/${encodeURIComponent(canonicalTag)}?mode=competitive&size=10&start=${start}`,
            { headers }
          );

          if (!matchesRes.ok) {
            break;
          }

          const matchesJson = await matchesRes.json();
          const pageMatches = Array.isArray(matchesJson?.data) ? matchesJson.data : [];

          if (!pageMatches.length) {
            break;
          }

          for (const match of pageMatches) {
            const seasonId = getSeasonId(match);

            if (!currentSeasonId && seasonId) {
              currentSeasonId = seasonId;
            }

            if (currentSeasonId && seasonId && seasonId !== currentSeasonId) {
              keepGoing = false;
              break;
            }

            collectedMatches.push(match);
          }

          start += 10;
        }

        if (!collectedMatches.length) {
          results.push({
            riotId: `${canonicalName}#${canonicalTag}`,
            seasonLabel: "Season 2026 // Act 2",
            matchesPlayed: 0,
            kd: 0,
            kda: "0 / 0 / 0",
            hs: 0,
            adr: 0,
            firstKills: 0,
            firstDeaths: 0,
            multikills: 0,
            agents: [],
          });
          continue;
        }

        let totalKills = 0;
        let totalDeaths = 0;
        let totalAssists = 0;
        let totalHeadshots = 0;
        let totalBodyshots = 0;
        let totalLegshots = 0;
        let totalDamage = 0;
        let totalFirstKills = 0;
        let totalFirstDeaths = 0;
        let totalMultikills = 0;
        const agentCounts = {};

        let matchesPlayed = 0;

        for (const match of collectedMatches) {
          const me = getMe(match, name, tag, canonicalName, canonicalTag);
          if (!me) continue;

          const stats = me?.stats || {};

          totalKills += pickNumber(stats, ["kills"]);
          totalDeaths += pickNumber(stats, ["deaths"]);
          totalAssists += pickNumber(stats, ["assists"]);

          totalHeadshots += pickNumber(stats, ["headshots", "hs"]);
          totalBodyshots += pickNumber(stats, ["bodyshots", "body_shots"]);
          totalLegshots += pickNumber(stats, ["legshots", "leg_shots"]);

          totalDamage += getDamage(me);

          totalFirstKills += pickNumber(stats, ["firstkills", "first_kills"]);
          totalFirstDeaths += pickNumber(stats, ["firstdeaths", "first_deaths"]);

          totalMultikills += getMultikills(me);

          const agent = me?.character || me?.agent?.name || null;
          if (agent) {
            agentCounts[agent] = (agentCounts[agent] || 0) + 1;
          }

          matchesPlayed += 1;
        }

        const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
        const hs = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;
        const kd = totalDeaths > 0 ? Number((totalKills / totalDeaths).toFixed(2)) : Number(totalKills.toFixed(2));
        const adr = matchesPlayed > 0 ? Math.round(totalDamage / matchesPlayed) : 0;

        const agents = Object.entries(agentCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([agent]) => agent)
          .slice(0, 5);

        results.push({
          riotId: `${canonicalName}#${canonicalTag}`,
          seasonLabel: "Season 2026 // Act 2",
          matchesPlayed,
          kd,
          kda: `${totalKills} / ${totalDeaths} / ${totalAssists}`,
          hs,
          adr,
          firstKills: totalFirstKills,
          firstDeaths: totalFirstDeaths,
          multikills: totalMultikills,
          agents,
        });
      } catch (playerError) {
        results.push({
          riotId: `${name}#${tag}`,
          seasonLabel: "Season 2026 // Act 2",
          matchesPlayed: 0,
          kd: 0,
          kda: "0 / 0 / 0",
          hs: 0,
          adr: 0,
          firstKills: 0,
          firstDeaths: 0,
          multikills: 0,
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
