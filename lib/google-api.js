// Calls to the Google Business Profile APIs. Each function takes a working
// access token and returns the same JSON shape the app has always received.



async function listLocations(access_token) {
  if (!access_token) return ({ success: false, error: "No access token" });
  try {
    const accountsRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
      headers: { "Authorization": `Bearer ${access_token}` },
    });
    const accountsData = await accountsRes.json();
    if (!accountsData.accounts || accountsData.accounts.length === 0) {
      return ({ success: false, error: "No Google Business accounts found on this login.", debug: accountsData });
    }

    const allLocations = [];
    const perAccountDebug = [];
    for (const acct of accountsData.accounts) {
      const locationsRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers`,
        { headers: { "Authorization": `Bearer ${access_token}` } }
      );
      const locationsData = await locationsRes.json();
      console.log(`[GOOGLE] Locations for ${acct.name} (${acct.type || "unknown"}): status=${locationsRes.status}`, JSON.stringify(locationsData));

      perAccountDebug.push({
        account: acct.name,
        type: acct.type || "unknown",
        http_status: locationsRes.status,
        // Surface Google's actual error reason if this call failed, instead of
        // silently treating "no locations field" the same as "genuinely empty".
        google_error: locationsData.error ? (locationsData.error.message || locationsData.error) : null,
        location_count: locationsData.locations?.length || 0,
      });

      if (locationsData.locations && locationsData.locations.length > 0) {
        for (const loc of locationsData.locations) {
          allLocations.push({
            account_id: acct.name,
            account_type: acct.type || null,
            location_id: loc.name, // e.g. "accounts/123/locations/456"
            title: loc.title,
            address: loc.storefrontAddress
              ? [loc.storefrontAddress.addressLines?.join(", "), loc.storefrontAddress.locality, loc.storefrontAddress.administrativeArea].filter(Boolean).join(", ")
              : null,
            website: loc.websiteUri || null,
          });
        }
      }
    }

    if (allLocations.length === 0) {
      return ({
        success: false,
        error: "No locations found on any account for this Google login.",
        debug: perAccountDebug,
      });
    }

    return ({ success: true, locations: allLocations });
  } catch (err) {
    return ({ success: false, error: err.message });
  }

}

async function fetchPerformance(access_token, location_id) {
  if (!access_token || !location_id) return ({ success: false, error: "Missing access_token or location_id" });
  try {
    const metrics = [
      "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
      "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
      "CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "WEBSITE_CLICKS",
    ];
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 180); // 6 months back covers both the monthly trend and 30/60-day deltas

    const params = new URLSearchParams();
    metrics.forEach(m => params.append("dailyMetrics", m));
    params.append("dailyRange.start_date.year", start.getFullYear());
    params.append("dailyRange.start_date.month", start.getMonth() + 1);
    params.append("dailyRange.start_date.day", start.getDate());
    params.append("dailyRange.end_date.year", end.getFullYear());
    params.append("dailyRange.end_date.month", end.getMonth() + 1);
    params.append("dailyRange.end_date.day", end.getDate());

    const perfRes = await fetch(
      `https://businessprofileperformance.googleapis.com/v1/${location_id}:fetchMultiDailyMetricsTimeSeries?${params}`,
      { headers: { "Authorization": `Bearer ${access_token}` } }
    );
    const perfData = await perfRes.json();
    console.log(`[GOOGLE] Performance API status=${perfRes.status}`, JSON.stringify(perfData).slice(0, 800));

    if (!perfRes.ok) {
      return ({ success: false, error: perfData.error?.message || "Performance API request failed.", http_status: perfRes.status });
    }

    // Flatten Google's nested response into { METRIC_NAME: [{date, value}] }
    const series = {};
    for (const group of (perfData.multiDailyMetricTimeSeries || [])) {
      for (const dm of (group.dailyMetricTimeSeries || [])) {
        const points = (dm.timeSeries?.datedValues || []).map(dv => ({
          date: `${dv.date.year}-${String(dv.date.month).padStart(2, "0")}-${String(dv.date.day).padStart(2, "0")}`,
          value: Number(dv.value || 0),
        }));
        series[dm.dailyMetric] = points;
      }
    }

    const combine = (...arrs) => {
      const byDate = {};
      arrs.forEach(arr => (arr || []).forEach(p => { byDate[p.date] = (byDate[p.date] || 0) + p.value; }));
      return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
    };
    const sum = (arr) => arr.reduce((a, b) => a + b.value, 0);

    const viewsSeries = combine(series.BUSINESS_IMPRESSIONS_DESKTOP_MAPS, series.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, series.BUSINESS_IMPRESSIONS_MOBILE_MAPS, series.BUSINESS_IMPRESSIONS_MOBILE_SEARCH);
    const callsSeries = series.CALL_CLICKS || [];
    const directionsSeries = series.BUSINESS_DIRECTION_REQUESTS || [];
    const websiteSeries = series.WEBSITE_CLICKS || [];

    const totalsFor = (arr) => {
      const last30 = sum(arr.slice(-30));
      const prior30 = sum(arr.slice(-60, -30));
      const delta = prior30 > 0 ? Math.round(((last30 - prior30) / prior30) * 1000) / 10 : null;
      return { total: last30, delta };
    };

    // Monthly aggregation — one trend array per metric, so the frontend can
    // let someone switch which metric the 6-month graph shows (not just views).
    const toMonthlyTrend = (series) => {
      const monthly = {};
      series.forEach(p => { const k = p.date.slice(0, 7); monthly[k] = (monthly[k] || 0) + p.value; });
      return Object.entries(monthly).sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([month, value]) => ({ month, value }));
    };
    const monthlyViewsTrend = toMonthlyTrend(viewsSeries);
    const monthlyTrends = {
      search_views: monthlyViewsTrend,
      calls: toMonthlyTrend(callsSeries),
      direction_requests: toMonthlyTrend(directionsSeries),
      website_clicks: toMonthlyTrend(websiteSeries),
    };

    return ({
      success: true,
      search_views: totalsFor(viewsSeries),
      calls: totalsFor(callsSeries),
      direction_requests: totalsFor(directionsSeries),
      website_clicks: totalsFor(websiteSeries),
      monthly_views_trend: monthlyViewsTrend, // kept for backward compatibility with the existing client-facing chart
      monthly_trends: monthlyTrends,
    });
  } catch (err) {
    return ({ success: false, error: err.message });
  }

}

async function fetchSearchKeywords(access_token, location_id) {
  if (!access_token || !location_id) return ({ success: false, error: "Missing access_token or location_id" });
  try {
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 3);

    const params = new URLSearchParams({
      "monthlyRange.start_month.year": start.getFullYear(),
      "monthlyRange.start_month.month": start.getMonth() + 1,
      "monthlyRange.end_month.year": end.getFullYear(),
      "monthlyRange.end_month.month": end.getMonth() + 1,
    });

    const kwRes = await fetch(
      `https://businessprofileperformance.googleapis.com/v1/${location_id}/searchkeywords/impressions/monthly?${params}`,
      { headers: { "Authorization": `Bearer ${access_token}` } }
    );
    const kwData = await kwRes.json();
    console.log(`[GOOGLE] Search keywords status=${kwRes.status}`, JSON.stringify(kwData).slice(0, 800));

    if (!kwRes.ok) {
      return ({ success: false, error: kwData.error?.message || "Search keywords request failed.", http_status: kwRes.status });
    }

    // Sum each term's impressions across the months returned; keep the
    // threshold label if Google never gave an exact number for that term.
    const totals = {};
    for (const monthly of (kwData.searchKeywordsCounts || [])) {
      const term = monthly.searchKeyword;
      const iv = monthly.insightsValue || {};
      if (!totals[term]) totals[term] = { numeric: 0, thresholdLabel: null };
      if (iv.value != null) totals[term].numeric += Number(iv.value);
      else if (iv.threshold != null) totals[term].thresholdLabel = iv.threshold;
    }

    const keywords = Object.entries(totals)
      .map(([term, t]) => ({ term, impressions: t.numeric > 0 ? t.numeric : (t.thresholdLabel || "< 100") }))
      .sort((a, b) => (typeof b.impressions === "number" ? b.impressions : 0) - (typeof a.impressions === "number" ? a.impressions : 0))
      .slice(0, 15);

    return ({ success: true, keywords });
  } catch (err) {
    return ({ success: false, error: err.message });
  }

}

async function fetchLocationData(access_token, account_id, location_id, business_id) {
  if (!access_token) return ({ success: false, error: "No access token" });
  try {
    let account, location, locationName;

    // If a specific location was chosen (from the picker), fetch it directly —
    // no need to re-scan every account.
    if (account_id && location_id) {
      const locationRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${location_id}?readMask=name,title,storefrontAddress,websiteUri,regularHours,phoneNumbers`,
        { headers: { "Authorization": `Bearer ${access_token}` } }
      );
      location = await locationRes.json();
      if (!location || !location.name) {
        return ({ success: false, error: "Could not fetch the selected location." });
      }
      account = { name: account_id };
      locationName = location.name;
    } else {
      // Fallback: no specific location chosen — auto-pick like before
      // (kept for backward compatibility / single-location businesses).
      // 1. Get accounts
      const accountsRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
        headers: { "Authorization": `Bearer ${access_token}` },
      });
      const accountsData = await accountsRes.json();
      console.log("[GOOGLE] Accounts API response:", JSON.stringify(accountsData));
      if (!accountsData.accounts || accountsData.accounts.length === 0) {
        console.log("[GOOGLE] No accounts found. Full response:", JSON.stringify(accountsData));
        return ({ success: false, error: "No Google Business accounts found. Make sure this Google account owns a Business Profile.", debug: accountsData });
      }
      // 2. FIX: try every account returned, not just accounts[0] — a Google login
      // can return multiple account resources (PERSONAL / ORGANIZATION / LOCATION_GROUP)
      // and only one of them may actually have locations attached.
      let locationsData = null;

      for (const candidate of accountsData.accounts) {
        const locationsRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${candidate.name}/locations?readMask=name,title,storefrontAddress,websiteUri,regularHours,phoneNumbers`,
          { headers: { "Authorization": `Bearer ${access_token}` } }
        );
        const candidateLocations = await locationsRes.json();
        console.log(`[GOOGLE] Locations for ${candidate.name} (${candidate.type || "unknown type"}):`, JSON.stringify(candidateLocations));

        if (candidateLocations.locations && candidateLocations.locations.length > 0) {
          account = candidate;
          locationsData = candidateLocations;
          break; // found an account with real locations — stop here
        }
      }

      if (!account || !locationsData) {
        return ({
          success: false,
          error: "No locations found on any of your Google accounts.",
          debug: accountsData.accounts.map(a => ({ name: a.name, type: a.type })),
        });
      }

      location = locationsData.locations[0];
      locationName = location.name;
    }

    // NOTE: this is now either the specific location the user picked, or —
    // if no location_id was passed — the first one auto-found (old behavior,
    // kept for backward compatibility).

    // 3. Fetch reviews. We pull more than the 5 we display so we can compute a
    // real sentiment breakdown (Google doesn't give you a star-count breakdown
    // directly — you have to fetch reviews and tally them yourself). Capped at
    // 150 reviews / 3 pages to keep this fast; sentiment is "based on your most
    // recent reviews" rather than literally every review ever for high-volume businesses.
    let rating = null;
    let reviewCount = null;
    let allFetchedReviews = [];
    let pageToken = null;
    let pagesFetched = 0;

    try {
      do {
        const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50&orderBy=updateTime%20desc${pageToken ? `&pageToken=${pageToken}` : ""}`;
        const reviewsRes = await fetch(url, { headers: { "Authorization": `Bearer ${access_token}` } });
        const reviewsData = await reviewsRes.json();

        if (pagesFetched === 0) {
          if (reviewsData.averageRating) rating = reviewsData.averageRating;
          if (reviewsData.totalReviewCount) reviewCount = reviewsData.totalReviewCount;
        }
        if (reviewsData.reviews && Array.isArray(reviewsData.reviews)) {
          allFetchedReviews.push(...reviewsData.reviews);
        }
        pageToken = reviewsData.nextPageToken || null;
        pagesFetched++;
      } while (pageToken && pagesFetched < 3);
    } catch (reviewErr) {
      console.warn("Reviews fetch failed (non-fatal):", reviewErr.message);
    }

    const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    const mapReview = (r) => {
      const updated = new Date(r.updateTime);
      const diffDays = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
      let time_ago = "recently";
      if (diffDays === 0) time_ago = "today";
      else if (diffDays === 1) time_ago = "1d ago";
      else if (diffDays < 7) time_ago = `${diffDays}d ago`;
      else if (diffDays < 30) time_ago = `${Math.floor(diffDays / 7)}w ago`;
      else if (diffDays < 365) time_ago = `${Math.floor(diffDays / 30)}mo ago`;
      else time_ago = `${Math.floor(diffDays / 365)}y ago`;
      return {
        reviewer_name: r.reviewer?.displayName || "Anonymous",
        star_rating: starMap[r.starRating] || 5,
        comment: r.comment || "",
        time_ago,
        replied: !!r.reviewReply,
      };
    };

    const reviews = allFetchedReviews.slice(0, 5).map(mapReview); // for the "recent reviews" list
    const sentiment = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let repliedCount = 0;
    allFetchedReviews.forEach(r => {
      const stars = starMap[r.starRating] || 5;
      sentiment[stars] = (sentiment[stars] || 0) + 1;
      if (r.reviewReply) repliedCount++;
    });
    const responseRate = allFetchedReviews.length > 0 ? Math.round((repliedCount / allFetchedReviews.length) * 100) : null;
    const now = new Date();
    const newThisMonth = allFetchedReviews.filter(r => {
      const d = new Date(r.updateTime);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;

    // 4. Save today's rating/review-count snapshot to Supabase so we can chart
    // rating history over time later — Google's API only ever gives you the
    // CURRENT rating, never a historical time series, so this is the only way
    // to build that trend. Requires a `rating_snapshots` table (see project docs).
    if (business_id && rating != null) {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_KEY;
      if (supabaseUrl && serviceKey) {
        try {
          const today = new Date().toISOString().slice(0, 10);
          await fetch(`${supabaseUrl}/rest/v1/rating_snapshots?on_conflict=business_id,snapshot_date`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": serviceKey,
              "Authorization": `Bearer ${serviceKey}`,
              "Prefer": "resolution=merge-duplicates",
            },
            body: JSON.stringify([{ business_id, snapshot_date: today, rating, review_count: reviewCount }]),
          });
        } catch (snapErr) {
          console.warn("Rating snapshot save failed (non-fatal):", snapErr.message);
        }
      }
    }

    return ({
      success: true,
      account_id: account.name,
      location_id: locationName,
      location_name: location.title,
      address: location.storefrontAddress,
      rating,
      review_count: reviewCount,
      reviews,
      sentiment,
      sentiment_based_on: allFetchedReviews.length,
      response_rate: responseRate,
      new_this_month: newThisMonth,
    });
  } catch (err) {
    return ({ success: false, error: err.message });
  }

}

module.exports = { listLocations, fetchPerformance, fetchSearchKeywords, fetchLocationData };
