(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const STORAGE_KEYS = {
    location: "aethersense.location.v2",
    recent: "aethersense.recent.v2",
    units: "aethersense.units.v2",
    theme: "aethersense.theme.v2"
  };

  const DEFAULT_LOCATION = {
    name: "Malang",
    admin1: "East Java",
    country: "Indonesia",
    latitude: -8.1635,
    longitude: 112.5729,
    timezone: "Asia/Jakarta"
  };

  let selectedLocation = loadStoredLocation() || DEFAULT_LOCATION;
  let weatherData = null;
  let airData = null;
  let unitSystem = safeStorageGet(STORAGE_KEYS.units) === "imperial" ? "imperial" : "metric";
  let lastSearchTerm = "";
  let toastTimer = null;
  let loading = false;

  const appRoot = $("#appRoot");
  const searchForm = $("#searchForm");
  const cityInput = $("#cityInput");
  const searchResults = $("#searchResults");
  const errorBanner = $("#errorBanner");
  const errorMessage = $("#errorMessage");
  const toast = $("#toast");

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode or storage disabled.
    }
  }

  function loadStoredLocation() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.location) || "null"
      );

      if (
        saved &&
        Number.isFinite(saved.latitude) &&
        Number.isFinite(saved.longitude) &&
        saved.name
      ) {
        return saved;
      }
    } catch {
      // Use the default location if saved data is missing or invalid.
    }

    return null;
  }

  function readRecentSearches() {
    try {
      const items = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.recent) || "[]"
      );

      return Array.isArray(items)
        ? items
            .filter(
              item =>
                item &&
                item.name &&
                Number.isFinite(item.latitude) &&
                Number.isFinite(item.longitude)
            )
            .slice(0, 4)
        : [];
    } catch {
      return [];
    }
  }

  function storeRecent(location) {
    const key =
      `${location.name}|${location.admin1 || ""}|${location.country || ""}`
        .toLowerCase();

    const recent = [
      location,
      ...readRecentSearches().filter(
        item =>
          `${item.name}|${item.admin1 || ""}|${item.country || ""}`
            .toLowerCase() !== key
      )
    ].slice(0, 4);

    safeStorageSet(STORAGE_KEYS.recent, JSON.stringify(recent));
    renderRecentSearches();
  }

  function locationLabel(location) {
    return [location.name, location.admin1, location.country]
      .filter(Boolean)
      .filter((part, index, arr) => arr.indexOf(part) === index)
      .join(", ");
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(
      () => toast.classList.remove("show"),
      2600
    );
  }

  function setLoading(isLoading, message) {
    loading = isLoading;

    const searchButton = $("#searchButton");
    const locateButton = $("#locateButton");
    const refreshButton = $("#refreshButton");

    searchButton.disabled = isLoading;
    locateButton.disabled = isLoading;
    refreshButton.disabled = isLoading;

    searchButton.querySelector("span:first-child").textContent =
      isLoading ? "Memuat…" : "Jelajahi";

    if (message) {
      $("#searchMessage").textContent = message;
    }
  }

  async function fetchJSON(url, timeout = 14000) {
    const controller = new AbortController();

    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(
          `Layanan mengembalikan status ${response.status}.`
        );
      }

      const payload = await response.json();

      if (payload && payload.error) {
        throw new Error(
          payload.reason ||
          "Layanan data tidak dapat memproses permintaan."
        );
      }

      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "Koneksi terlalu lama. Silakan coba lagi."
        );
      }

      if (error instanceof TypeError) {
        throw new Error(
          "Tidak dapat terhubung ke layanan data. Periksa koneksi internet."
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function buildURL(base, params) {
    const url = new URL(base);

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });

    return url.toString();
  }

  async function getWeather(location) {
    const url = buildURL(
      "https://api.open-meteo.com/v1/forecast",
      {
        latitude: location.latitude,
        longitude: location.longitude,

        current:
          "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure",

        hourly:
          "temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,uv_index,visibility,wind_speed_10m",

        daily:
          "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max,sunrise,sunset,et0_fao_evapotranspiration",

        timezone: "auto",
        forecast_days: 7
      }
    );

    return fetchJSON(url);
  }

  async function getAirQuality(location) {
    const url = buildURL(
      "https://air-quality-api.open-meteo.com/v1/air-quality",
      {
        latitude: location.latitude,
        longitude: location.longitude,
        current: "european_aqi,pm2_5,pm10",
        hourly: "european_aqi,pm2_5,pm10",
        timezone: "auto",
        forecast_hours: 24
      }
    );

    return fetchJSON(url, 16000);
  }

  async function loadLocation(location, options = {}) {
    if (loading) return;

    const previousLocation = selectedLocation;
    const previousWeather = weatherData;
    const previousAir = airData;

    setLoading(
      true,
      `Mengambil data untuk ${locationLabel(location)}…`
    );

    errorBanner.hidden = true;
    hideSearchResults();

    selectedLocation = location;

    $("#locationName").textContent = locationLabel(location);
    document.title = `${location.name} — AetherSense`;

    renderLoadingState();

    try {
      const [weatherResult, airResult] =
        await Promise.allSettled([
          getWeather(location),
          getAirQuality(location)
        ]);

      if (weatherResult.status === "rejected") {
        throw weatherResult.reason;
      }

      weatherData = weatherResult.value;

      airData =
        airResult.status === "fulfilled"
          ? airResult.value
          : null;

      if (
        !weatherData.current ||
        !weatherData.daily ||
        !weatherData.hourly
      ) {
        throw new Error(
          "Data cuaca belum lengkap. Silakan coba beberapa saat lagi."
        );
      }

      if (options.persist !== false) {
        safeStorageSet(
          STORAGE_KEYS.location,
          JSON.stringify(location)
        );
      }

      if (options.remember !== false) {
        storeRecent(location);
      }

      renderAll();

      const warning =
        airResult.status === "rejected"
          ? " Cuaca tersedia, tetapi layanan kualitas udara sedang tidak merespons."
          : "";

      setLoading(
        false,
        `Menampilkan kondisi ${locationLabel(location)}.${warning}`
      );

      if (airResult.status === "rejected") {
        showToast(
          "Data cuaca diperbarui; kualitas udara sementara tidak tersedia."
        );
      }

      $("#lastUpdated").textContent =
        `Diperbarui ${new Date().toLocaleTimeString("id-ID", {
          hour: "2-digit",
          minute: "2-digit"
        })}`;
    } catch (error) {
      selectedLocation = previousLocation;
      weatherData = previousWeather;
      airData = previousAir;

      safeStorageSet(
        STORAGE_KEYS.location,
        JSON.stringify(previousLocation)
      );

      $("#locationName").textContent =
        locationLabel(previousLocation);

      document.title =
        `${previousLocation.name} — AetherSense`;

      if (weatherData) {
        renderAll();
      } else {
        renderUnavailableState();
      }

      setLoading(
        false,
        "Belum berhasil mengambil data. Coba lagi atau pilih kota lain."
      );

      errorMessage.textContent =
        error.message ||
        "Terjadi kesalahan tak terduga. Silakan coba lagi.";

      errorBanner.hidden = false;

      showToast("Data belum berhasil dimuat.");
    }
  }

  function renderLoadingState() {
    $("#hourlyForecast").innerHTML =
      '<div class="loading-card">Menyusun prakiraan per jam…</div>';

    $("#dailyForecast").innerHTML =
      '<div class="loading-card">Membaca pola cuaca mingguan…</div>';

    $("#overviewRecommendations").innerHTML =
      '<div class="loading-card">Menyiapkan rekomendasi kontekstual…</div>';
  }

  function renderUnavailableState() {
    $("#currentCondition").textContent =
      "Data belum tersedia";

    $("#currentDescription").textContent =
      "Periksa koneksi internet atau coba kota lain.";

    $("#currentTemp").textContent = "—°";
    $("#currentWeatherIcon").textContent = "☁";
  }

  function renderAll() {
    renderWeather();
    renderHourlyForecast();
    renderDailyForecast();
    renderAirQuality();
    renderRecommendations();
    renderAgriculture();

    applyWeatherTheme(
      weatherData.current.weather_code
    );

    renderCurrentTime();
  }

  function weatherCodeInfo(code) {
    const c = Number(code);

    if (c === 0) {
      return {
        label: "Cerah",
        icon: "☀",
        description:
          "Langit relatif cerah. Kondisi dapat terasa lebih hangat saat matahari berada tinggi."
      };
    }

    if ([1, 2].includes(c)) {
      return {
        label: c === 1 ? "Cerah berawan" : "Berawan sebagian",
        icon: "🌤",
        description:
          "Awan dan matahari berbagi langit. Perubahan kondisi masih mungkin terjadi."
      };
    }

    if (c === 3) {
      return {
        label: "Berawan",
        icon: "☁",
        description:
          "Tutupan awan cukup dominan. Perhatikan prakiraan hujan untuk rencana luar ruang."
      };
    }

    if ([45, 48].includes(c)) {
      return {
        label: "Berkabut",
        icon: "🌫",
        description:
          "Jarak pandang dapat berkurang. Berhati-hatilah saat bepergian."
      };
    }

    if ([51, 53, 55].includes(c)) {
      return {
        label: "Gerimis",
        icon: "🌦",
        description:
          "Gerimis ringan hingga lebih rapat mungkin terjadi pada kondisi ini."
      };
    }

    if ([56, 57].includes(c)) {
      return {
        label: "Gerimis membeku",
        icon: "🌧",
        description:
          "Model mendeteksi gerimis membeku; kondisi ini jarang terjadi di wilayah tropis."
      };
    }

    if ([61, 63, 65].includes(c)) {
      return {
        label: "Hujan",
        icon: "🌧",
        description:
          "Hujan dengan intensitas bervariasi. Bawa perlengkapan hujan jika bepergian."
      };
    }

    if ([66, 67].includes(c)) {
      return {
        label: "Hujan membeku",
        icon: "🌧",
        description:
          "Model mendeteksi hujan membeku; konfirmasikan dengan sumber cuaca lokal."
      };
    }

    if ([71, 73, 75, 77].includes(c)) {
      return {
        label: "Salju",
        icon: "❄",
        description:
          "Kondisi bersalju terindikasi pada model untuk lokasi ini."
      };
    }

    if ([80, 81, 82].includes(c)) {
      return {
        label: "Hujan lokal",
        icon: "🌦",
        description:
          "Hujan singkat atau hujan lokal dapat lewat. Pantau perubahan langit."
      };
    }

    if ([85, 86].includes(c)) {
      return {
        label: "Hujan salju",
        icon: "🌨",
        description:
          "Prakiraan menunjukkan kemungkinan hujan salju."
      };
    }

    if ([95, 96, 99].includes(c)) {
      return {
        label: "Badai petir",
        icon: "⛈",
        description:
          "Ada indikasi badai petir. Tunda aktivitas terbuka saat petir atau cuaca berbahaya terjadi."
      };
    }

    return {
      label: "Kondisi bervariasi",
      icon: "☁",
      description:
        "Lihat pembaruan berkala untuk memahami perubahan kondisi langit."
    };
  }

  function weatherTheme(code) {
    const c = Number(code);

    if (c === 0 || c === 1) return "clear";
    if ([2, 3].includes(c)) return "cloud";
    if ([45, 48].includes(c)) return "fog";
    if ([71, 73, 75, 77, 85, 86].includes(c)) return "snow";
    if ([95, 96, 99].includes(c)) return "storm";

    return "rain";
  }

  function applyWeatherTheme(code) {
    appRoot.dataset.weather = weatherTheme(code);
  }

  function hourlyIndexAtCurrent(data) {
    const currentTime = data?.current?.time;
    const times = data?.hourly?.time || [];

    if (!currentTime || !times.length) return 0;

    const hourKey = String(currentTime).slice(0, 13);

    const index = times.findIndex(
      time => String(time).slice(0, 13) === hourKey
    );

    if (index >= 0) return index;

    const currentHour =
      Number(String(currentTime).slice(11, 13));

    const found = times.findIndex(
      time => Number(String(time).slice(11, 13)) === currentHour
    );

    return Math.max(0, found);
  }

  function hourlyNow(key) {
    const index = hourlyIndexAtCurrent(weatherData);

    return weatherData?.hourly?.[key]?.[index] ?? null;
  }

  function toFahrenheit(celsius) {
    return celsius == null || !Number.isFinite(Number(celsius))
      ? null
      : Number(celsius) * 9 / 5 + 32;
  }

  function fromKmh(kmh) {
    return kmh == null || !Number.isFinite(Number(kmh))
      ? null
      : unitSystem === "imperial"
        ? Number(kmh) * 0.621371
        : Number(kmh);
  }

  function fromMm(mm) {
    return mm == null || !Number.isFinite(Number(mm))
      ? null
      : unitSystem === "imperial"
        ? Number(mm) / 25.4
        : Number(mm);
  }

  function temperature(value) {
    if (value == null || !Number.isFinite(Number(value))) {
      return "—";
    }

    const out =
      unitSystem === "imperial"
        ? toFahrenheit(Number(value))
        : Number(value);

    return `${Math.round(out)}°`;
  }

  function windSpeed(value) {
    const converted = fromKmh(value);

    return converted == null
      ? "—"
      : `${Math.round(converted)} ${unitSystem === "imperial" ? "mph" : "km/j"}`;
  }

  function rainAmount(value) {
    const converted = fromMm(value);

    if (converted == null) return "—";

    return `${converted.toLocaleString("id-ID", {
      maximumFractionDigits: 1
    })} ${unitSystem === "imperial" ? "in" : "mm"}`;
  }

  function numberOrDash(value, decimals = 0) {
    if (value == null || !Number.isFinite(Number(value))) {
      return "—";
    }

    return Number(value).toLocaleString("id-ID", {
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals
    });
  }

  function setText(selector, value) {
    const node = $(selector);

    if (node) {
      node.textContent =
        value == null || value === "" ? "—" : value;
    }
  }

  function asNumber(value) {
    const n = Number(value);

    return Number.isFinite(n) ? n : null;
  }

  function directionLabel(degrees) {
    if (
      degrees == null ||
      !Number.isFinite(Number(degrees))
    ) {
      return "—";
    }

    const directions = [
      "Utara",
      "Timur Laut",
      "Timur",
      "Tenggara",
      "Selatan",
      "Barat Daya",
      "Barat",
      "Barat Laut"
    ];

    return directions[
      Math.round((Number(degrees) % 360) / 45) % 8
    ];
  }

  function uvCategory(value) {
    const uv = asNumber(value);

    if (uv == null) {
      return {
        label: "Tidak tersedia",
        level: "unknown"
      };
    }

    if (uv < 3) {
      return { label: "Rendah", level: "good" };
    }

    if (uv < 6) {
      return { label: "Sedang", level: "fair" };
    }

    if (uv < 8) {
      return { label: "Tinggi", level: "moderate" };
    }

    if (uv < 11) {
      return { label: "Sangat tinggi", level: "poor" };
    }

    return { label: "Ekstrem", level: "very-poor" };
  }

  function renderWeather() {
    const current = weatherData.current;
    const info = weatherCodeInfo(current.weather_code);
    const uv = hourlyNow("uv_index");
    const visibility = hourlyNow("visibility");
    const today = weatherData.daily;

    setText("#currentTemp", temperature(current.temperature_2m));
    setText("#currentWeatherIcon", info.icon);
    setText("#currentCondition", info.label);
    setText("#currentDescription", info.description);

    setText("#feelsLike", temperature(current.apparent_temperature));

    setText(
      "#heroUV",
      uv == null ? "—" : numberOrDash(uv, 1)
    );

    setText(
      "#todayHigh",
      temperature(today.temperature_2m_max?.[0])
    );

    setText(
      "#todayLow",
      temperature(today.temperature_2m_min?.[0])
    );

    setText(
      "#rainChance",
      `${numberOrDash(today.precipitation_probability_max?.[0])}%`
    );

    setText(
      "#humidityValue",
      numberOrDash(current.relative_humidity_2m)
    );

    setText(
      "#humidityNote",
      current.relative_humidity_2m >= 75
        ? "Udara terasa lembap"
        : current.relative_humidity_2m <= 35
          ? "Kelembapan relatif rendah"
          : "Kelembapan relatif"
    );

    setText("#windValue", windSpeed(current.wind_speed_10m));

    setText(
      "#windNote",
      `Arah ${directionLabel(current.wind_direction_10m)}`
    );

    setText(
      "#uvValue",
      uv == null ? "—" : numberOrDash(uv, 1)
    );

    const uvInfo = uvCategory(uv);

    setText("#uvNote", uvInfo.label);

    $("#uvMeterFill").style.width =
      `${Math.min(100, Math.max(0, (Number(uv) || 0) / 11 * 100))}%`;

    setText(
      "#pressureValue",
      `${numberOrDash(current.surface_pressure)} hPa`
    );

    const visibilityKm =
      visibility == null ? null : Number(visibility) / 1000;

    const visibilityDisplay =
      visibilityKm == null
        ? null
        : unitSystem === "imperial"
          ? visibilityKm * 0.621371
          : visibilityKm;

    setText(
      "#visibilityValue",
      visibilityDisplay == null
        ? "—"
        : `${numberOrDash(visibilityDisplay, 1)} ${unitSystem === "imperial" ? "mi" : "km"}`
    );

    setText(
      "#visibilityNote",
      visibilityKm == null
        ? "Estimasi visibilitas"
        : visibilityKm < 1
          ? "Jarak pandang rendah"
          : visibilityKm < 4
            ? "Jarak pandang terbatas"
            : "Jarak pandang cukup baik"
    );

    setText(
      "#searchMessage",
      "Data model cuaca untuk lokasi terpilih."
    );

    setText("#localTime", formatApiTime(current.time));

    setText(
      "#farmTempRange",
      `${temperature(today.temperature_2m_min?.[0])} / ${temperature(today.temperature_2m_max?.[0])}`
    );

    setText(
      "#farmRain",
      rainAmount(today.precipitation_sum?.[0])
    );

    setText(
      "#farmRainChance",
      `${numberOrDash(today.precipitation_probability_max?.[0])}%`
    );

    setText(
      "#farmUV",
      numberOrDash(today.uv_index_max?.[0], 1)
    );

    const et0 = asNumber(
      today.et0_fao_evapotranspiration?.[0]
    );

    setText(
      "#et0Value",
      et0 == null
        ? "—"
        : `${numberOrDash(unitSystem === "imperial" ? et0 / 25.4 : et0, 1)} ${unitSystem === "imperial" ? "in" : "mm"}`
    );

    updateUnitToggle();
  }

  function formatApiTime(value) {
    if (!value) return "Waktu lokal —";

    const time = String(value).slice(11, 16);
    const datePart = String(value).slice(0, 10);
    const date = new Date(`${datePart}T12:00:00`);

    const weekday = date.toLocaleDateString("id-ID", {
      weekday: "short",
      day: "numeric",
      month: "short"
    });

    return `${weekday} · ${time}`;
  }

  function renderCurrentTime() {
    const now = new Date();

    setText(
      "#todayLabel",
      now.toLocaleDateString("id-ID", {
        weekday: "short",
        day: "numeric",
        month: "short"
      })
    );
  }

  function formatHour(value) {
    if (!value) return "—";

    const h = Number(String(value).slice(11, 13));

    if (!Number.isFinite(h)) return "—";

    return `${String(h).padStart(2, "0")}:00`;
  }

  function weekdayName(dateString, index) {
    if (index === 0) return "Hari ini";
    if (index === 1) return "Besok";

    const date = new Date(`${dateString}T12:00:00`);

    return date.toLocaleDateString("id-ID", {
      weekday: "short"
    });
  }

  function shortDate(dateString) {
    const date = new Date(`${dateString}T12:00:00`);

    return date.toLocaleDateString("id-ID", {
      day: "numeric",
      month: "short"
    });
  }

  function renderHourlyForecast() {
    const container = $("#hourlyForecast");
    const hourly = weatherData.hourly;
    const start = hourlyIndexAtCurrent(weatherData);

    container.replaceChildren();

    for (let offset = 0; offset < 8; offset++) {
      const index = start + offset;

      if (!hourly.time[index]) break;

      const info = weatherCodeInfo(
        hourly.weather_code?.[index]
      );

      const card = document.createElement("article");
      card.className = "hour-card";

      const time = document.createElement("div");
      time.className = "hour-time";
      time.textContent =
        offset === 0
          ? "Sekarang"
          : formatHour(hourly.time[index]);

      const icon = document.createElement("div");
      icon.className = "hour-icon";
      icon.textContent = info.icon;
      icon.setAttribute("aria-label", info.label);

      const temp = document.createElement("div");
      temp.className = "hour-temp";
      temp.textContent = temperature(
        hourly.temperature_2m?.[index]
      );

      const rain = document.createElement("div");
      rain.className = "hour-rain";
      rain.textContent =
        `☂ ${numberOrDash(hourly.precipitation_probability?.[index])}%`;

      card.append(time, icon, temp, rain);
      container.append(card);
    }

    if (!container.children.length) {
      container.innerHTML =
        '<div class="loading-card">Prakiraan per jam tidak tersedia.</div>';
    }
  }

  function renderDailyForecast() {
    const container = $("#dailyForecast");
    const daily = weatherData.daily;

    container.replaceChildren();

    (daily.time || []).forEach((date, index) => {
      const row = document.createElement("div");
      row.className = "daily-row";

      const day = document.createElement("div");
      day.className = "daily-day";
      day.textContent =
        `${weekdayName(date, index)}${index > 1 ? ` · ${shortDate(date)}` : ""}`;

      const conditions = document.createElement("div");
      conditions.className = "daily-icon-cell";

      const icon = document.createElement("span");
      icon.className = "daily-icon";
      icon.textContent =
        weatherCodeInfo(daily.weather_code?.[index]).icon;

      const label = document.createElement("span");
      label.textContent =
        weatherCodeInfo(daily.weather_code?.[index]).label;

      conditions.append(icon, label);

      const range = document.createElement("div");
      range.className = "daily-range";

      const high = document.createElement("span");
      high.textContent =
        temperature(daily.temperature_2m_max?.[index]);

      const track = document.createElement("span");
      track.className = "temp-track";
      track.setAttribute("aria-hidden", "true");

      const low = document.createElement("span");
      low.className = "daily-low";
      low.textContent =
        temperature(daily.temperature_2m_min?.[index]);

      range.append(high, track, low);

      const rain = document.createElement("div");
      rain.className = "daily-rain";

      const rainLabel = document.createElement("span");
      rainLabel.textContent =
        `${numberOrDash(daily.precipitation_probability_max?.[index])}%`;

      const rainMini = document.createElement("span");
      rainMini.className = "rain-mini";

      const rainFill = document.createElement("i");

      rainFill.style.width =
        `${Math.min(100, Math.max(0, Number(daily.precipitation_probability_max?.[index]) || 0))}%`;

      rainMini.append(rainFill);
      rain.append(rainLabel, rainMini);

      const uv = document.createElement("div");
      uv.className = "daily-uv";
      uv.textContent =
        `UV ${numberOrDash(daily.uv_index_max?.[index], 1)}`;

      row.append(day, conditions, range, rain, uv);
      container.append(row);
    });

    if (!container.children.length) {
      container.innerHTML =
        '<div class="loading-card">Prakiraan harian tidak tersedia.</div>';
    }

    renderFarmWeek();
  }

  function airQualityInfo(value) {
    const aqi = asNumber(value);

    if (aqi == null) {
      return {
        level: "unknown",
        label: "Tidak tersedia",
        title: "Belum ada pembacaan kualitas udara",
        summary:
          "Layanan kualitas udara belum mengembalikan data untuk waktu ini.",
        color: "#8299ad",
        advice:
          "Coba perbarui data beberapa saat lagi."
      };
    }

    if (aqi <= 20) {
      return {
        level: "good",
        label: "Baik",
        title: "Kondisi relatif baik",
        summary:
          "Indeks berada pada kategori baik. Tetap perhatikan kondisi lokal yang dapat berbeda dari model.",
        color: "#8edbc6",
        advice:
          "Kondisi ini umumnya mendukung aktivitas luar ruang bagi kebanyakan orang."
      };
    }

    if (aqi <= 40) {
      return {
        level: "fair",
        label: "Cukup",
        title: "Kualitas udara cukup baik",
        summary:
          "Indeks sedikit meningkat. Perhatikan jika kamu sensitif terhadap perubahan kualitas udara.",
        color: "#bedfa1",
        advice:
          "Aktivitas rutin bisa direncanakan sambil mengamati kondisi dan gejala pribadi."
      };
    }

    if (aqi <= 60) {
      return {
        level: "moderate",
        label: "Sedang",
        title: "Partikel dan polutan perlu dicermati",
        summary:
          "Kualitas udara berada di rentang sedang menurut skala European AQI.",
        color: "#f3cc88",
        advice:
          "Kurangi paparan yang tidak perlu jika kamu merasa tidak nyaman saat beraktivitas di luar."
      };
    }

    if (aqi <= 80) {
      return {
        level: "poor",
        label: "Buruk",
        title: "Pertimbangkan paparan di luar ruang",
        summary:
          "Indeks berada di kategori buruk. Pertimbangkan mengurangi kegiatan berat di area terbuka.",
        color: "#efaa91",
        advice:
          "Kelompok sensitif sebaiknya lebih berhati-hati dan mengikuti informasi kualitas udara resmi."
      };
    }

    if (aqi <= 100) {
      return {
        level: "very-poor",
        label: "Sangat buruk",
        title: "Waspadai kualitas udara",
        summary:
          "Indeks mencapai kategori sangat buruk menurut European AQI.",
        color: "#de8fa6",
        advice:
          "Batasi paparan luar ruang yang tidak diperlukan dan ikuti panduan otoritas kesehatan setempat."
      };
    }

    return {
      level: "extreme",
      label: "Ekstrem",
      title: "Indeks sangat tinggi",
      summary:
        "Indeks berada di atas rentang kategori sangat buruk. Nilai tinggi ini perlu ditanggapi dengan kehati-hatian.",
      color: "#d77b98",
      advice:
        "Tunda aktivitas luar ruang yang tidak penting dan ikuti informasi resmi setempat."
    };
  }

  function pollutantInfo(value, kind) {
    const number = asNumber(value);

    if (number == null) {
      return {
        label: "Tidak tersedia",
        width: 0,
        note: "Belum ada data konsentrasi."
      };
    }

    const limits =
      kind === "pm25"
        ? [5, 15, 50, 90, 140]
        : [15, 45, 120, 195, 270];

    const labels = [
      "Baik",
      "Cukup",
      "Sedang",
      "Buruk",
      "Sangat buruk",
      "Ekstrem"
    ];

    const index = limits.findIndex(
      limit => number <= limit
    );

    const label = labels[index < 0 ? 5 : index];

    const width = Math.min(
      100,
      Math.max(
        2,
        (number / (kind === "pm25" ? 150 : 300)) * 100
      )
    );

    return {
      label,
      width,
      note:
        `${label} pada rentang konsentrasi ${kind === "pm25" ? "PM2.5" : "PM10"} yang ditampilkan. Nilai model dapat berbeda dari pembacaan lokal.`
    };
  }

  function setAQDial(selector, value, info) {
    const dial = $(selector);

    if (!dial) return;

    const aqi = asNumber(value);

    const fill =
      aqi == null
        ? 0
        : Math.min(100, Math.max(0, (aqi / 120) * 100));

    dial.style.setProperty("--dial-value", `${fill}%`);
    dial.style.setProperty("--aq-color", info.color);
  }

  function renderAirQuality() {
    const current = airData?.current;

    const aqi = current?.european_aqi;
    const pm25 = current?.pm2_5;
    const pm10 = current?.pm10;

    const info = airQualityInfo(aqi);

    setAQDial("#aqDial", aqi, info);
    setAQDial("#aqDialLarge", aqi, info);

    setText(
      "#aqiValue",
      aqi == null ? "—" : numberOrDash(aqi)
    );

    setText(
      "#aqiValueLarge",
      aqi == null ? "—" : numberOrDash(aqi)
    );

    [
      "#aqStatusLabel",
      "#aqStatusLabelLarge"
    ].forEach(sel => {
      const el = $(sel);
      el.textContent = info.label;
      el.dataset.level = info.level;
    });

    setText("#aqStatusTitle", info.title);
    setText("#aqStatusTitleLarge", info.title);

    setText("#aqSummary", info.summary);
    setText("#aqSummaryLarge", info.summary);

    setText(
      "#pm25Preview",
      pm25 == null ? "— µg/m³" : `${numberOrDash(pm25, 1)} µg/m³`
    );

    setText(
      "#pm10Preview",
      pm10 == null ? "— µg/m³" : `${numberOrDash(pm10, 1)} µg/m³`
    );

    const pm25Info = pollutantInfo(pm25, "pm25");
    const pm10Info = pollutantInfo(pm10, "pm10");

    $("#pm25Bar").style.width = `${pm25Info.width}%`;
    $("#pm10Bar").style.width = `${pm10Info.width}%`;

    setText(
      "#pm25Value",
      pm25 == null ? "—" : `${numberOrDash(pm25, 1)} µg/m³`
    );

    setText(
      "#pm10Value",
      pm10 == null ? "—" : `${numberOrDash(pm10, 1)} µg/m³`
    );

    $("#pm25DetailBar").style.width =
      `${pm25Info.width}%`;

    $("#pm10DetailBar").style.width =
      `${pm10Info.width}%`;

    setText("#pm25Note", pm25Info.note);
    setText("#pm10Note", pm10Info.note);

    setText(
      "#airDataTime",
      current?.time ? formatApiTime(current.time) : "Tidak tersedia"
    );

    renderAirChart();
    renderAirRecommendations(info, pm25, pm10);
  }

  function renderAirChart() {
    const container = $("#airChart");

    const times = airData?.hourly?.time || [];
    const aqiValues = airData?.hourly?.european_aqi || [];

    container.replaceChildren();

    const currentTime = airData?.current?.time;

    let start = times.findIndex(
      time =>
        String(time).slice(0, 13) ===
        String(currentTime || "").slice(0, 13)
    );

    if (start < 0) start = 0;

    const selected = [];

    for (let i = 0; i < 8; i++) {
      const idx = start + i * 3;

      if (idx < times.length && aqiValues[idx] != null) {
        selected.push({
          time: times[idx],
          value: aqiValues[idx]
        });
      }
    }

    if (!selected.length) {
      container.innerHTML =
        '<div class="loading-card">Prakiraan kualitas udara tidak tersedia.</div>';
      return;
    }

    selected.forEach(item => {
      const column = document.createElement("div");
      column.className = "chart-column";

      const value = document.createElement("span");
      value.className = "chart-value";
      value.textContent = numberOrDash(item.value);

      const barArea = document.createElement("div");
      barArea.className = "chart-bar-area";

      const bar = document.createElement("div");
      bar.className = "chart-bar";

      bar.style.height =
        `${Math.max(4, Math.min(100, (Number(item.value) / 120) * 100))}%`;

      const info = airQualityInfo(item.value);

      bar.style.background =
        `linear-gradient(180deg, ${info.color}, color-mix(in srgb, ${info.color} 42%, transparent))`;

      bar.setAttribute(
        "title",
        `${numberOrDash(item.value)} EU AQI`
      );

      barArea.append(bar);

      const label = document.createElement("span");
      label.className = "chart-label";
      label.textContent = formatHour(item.time);

      column.append(value, barArea, label);
      container.append(column);
    });
  }

   function createRecommendationItem(item) {
    const row = document.createElement("article");
    row.className = "recommendation-item";

    const icon = document.createElement("span");
    icon.className = "recommendation-icon";
    icon.textContent = item.icon || "✳";
    icon.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");

    const title = document.createElement("strong");
    title.textContent = item.title;

    const description = document.createElement("p");
    description.textContent = item.text;

    body.append(title, description);
    row.append(icon, body);

    return row;
  }

  function createInsightCard(item) {
    const card = document.createElement("article");
    card.className = "insight-card";

    const icon = document.createElement("span");
    icon.className = "insight-card-icon";
    icon.textContent = item.icon || "✳";
    icon.setAttribute("aria-hidden", "true");

    const title = document.createElement("h3");
    title.textContent = item.title;

    const text = document.createElement("p");
    text.textContent = item.text;

    card.append(icon, title, text);

    return card;
  }

  function renderList(container, items, factory = createRecommendationItem) {
    if (!container) return;

    container.replaceChildren();

    items.forEach(item => {
      container.append(factory(item));
    });
  }

  // Rekomendasi untuk kesehatan dan aktivitas luar ruang.
  function buildHealthRecommendations() {
    const current = weatherData.current;
    const uv = asNumber(hourlyNow("uv_index"));
    const feelsLike = asNumber(current.apparent_temperature);
    const aqi = airData?.current?.european_aqi;
    const aqiInfo = airQualityInfo(aqi);

    const recommendations = [];

    if (feelsLike !== null && feelsLike >= 33) {
      recommendations.push({
        icon: "☀",
        title: "Perhatikan suhu terasa",
        text: `Suhu terasa sekitar ${temperature(feelsLike)}. Pertimbangkan jeda di tempat teduh dan minum air secara teratur ketika beraktivitas.`
      });
    } else if (feelsLike !== null && feelsLike <= 18) {
      recommendations.push({
        icon: "◇",
        title: "Bersiap untuk udara sejuk",
        text: "Sesuaikan pakaian dengan kondisi cuaca dan perubahan suhu selama beraktivitas."
      });
    }

    if (uv !== null && uv >= 6) {
      recommendations.push({
        icon: "☼",
        title: "Paparan UV meningkat",
        text: `Indeks UV sekitar ${numberOrDash(uv, 1)} (${uvCategory(uv).label.toLowerCase()}). Cari tempat teduh dan gunakan perlindungan matahari yang sesuai.`
      });
    } else if (uv !== null && uv < 3) {
      recommendations.push({
        icon: "◌",
        title: "Indeks UV relatif rendah",
        text: "Tetap pertimbangkan durasi aktivitas di bawah sinar matahari, meskipun indeks UV relatif rendah."
      });
    }

    if (aqi !== null && aqi !== undefined) {
      recommendations.push({
        icon: "◍",
        title: `Kualitas udara: ${aqiInfo.label.toLowerCase()}`,
        text: aqiInfo.advice
      });
    }

    const rainChance = asNumber(
      weatherData.daily.precipitation_probability_max?.[0]
    );

    if (rainChance !== null && rainChance >= 55) {
      recommendations.push({
        icon: "☂",
        title: "Sediakan rencana hujan",
        text: `Peluang hujan harian mencapai ${Math.round(rainChance)}%. Periksa kembali prakiraan sebelum bepergian.`
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        icon: "✳",
        title: "Amati perubahan lokal",
        text: "Periksa kembali prakiraan sebelum kegiatan penting karena kondisi nyata dapat berbeda dari hasil model."
      });
    }

    return recommendations.slice(0, 3);
  }

  // Rekomendasi untuk memahami kualitas udara.
  function buildAirRecommendations() {
    const aqi = airData?.current?.european_aqi;
    const info = airQualityInfo(aqi);
    const pm25 = asNumber(airData?.current?.pm2_5);
    const pm10 = asNumber(airData?.current?.pm10);

    const items = [
      {
        icon: "◌",
        title: "Pahami indeks kualitas udara",
        text: `${info.advice} European AQI memiliki skala tersendiri dan tidak dapat dibandingkan langsung dengan US AQI.`
      }
    ];

    if (pm25 !== null && pm25 > 15) {
      items.push({
        icon: "≋",
        title: "Perhatikan partikulat halus",
        text: `PM2.5 model menunjukkan ${numberOrDash(pm25, 1)} µg/m³. Nilai ini merupakan estimasi area, bukan pengukuran personal.`
      });
    } else {
      items.push({
        icon: "≋",
        title: "Pantau sumber polusi lokal",
        text: "Konsentrasi partikel dapat berubah di dekat jalan padat, lokasi konstruksi, atau sumber pembakaran."
      });
    }

    if (pm10 !== null && pm10 > 45) {
      items.push({
        icon: "⌁",
        title: "Perhatikan partikulat PM10",
        text: `PM10 model menunjukkan ${numberOrDash(pm10, 1)} µg/m³. Debu dan kegiatan lokal dapat memengaruhi kondisi aktual.`
      });
    } else {
      items.push({
        icon: "↗",
        title: "Gunakan data sebagai gambaran umum",
        text: "Untuk keputusan penting, bandingkan dengan informasi kualitas udara resmi di wilayah setempat."
      });
    }

    return items.slice(0, 3);
  }

  function renderAirRecommendations(info, pm25, pm10) {
    renderList(
      $("#airRecommendations"),
      buildAirRecommendations(),
      createInsightCard
    );
  }

  // Rekomendasi umum untuk pertanian dan irigasi.
  function buildFarmRecommendations() {
    const daily = weatherData.daily;

    const rainChance = asNumber(
      daily.precipitation_probability_max?.[0]
    );

    const rain = asNumber(
      daily.precipitation_sum?.[0]
    );

    const et0 = asNumber(
      daily.et0_fao_evapotranspiration?.[0]
    );

    const wind = asNumber(
      weatherData.current.wind_speed_10m
    );

    const uv = asNumber(
      daily.uv_index_max?.[0]
    );

    const items = [];

    if (rainChance !== null && rainChance >= 60) {
      items.push({
        icon: "☂",
        title: "Periksa peluang hujan sebelum irigasi",
        text: `Peluang hujan sekitar ${Math.round(rainChance)}% dengan prakiraan curah hujan ${rain === null ? "tidak tersedia" : `${numberOrDash(rain, 1)} mm`}. Periksa kondisi tanah sebelum mengubah jadwal penyiraman.`
      });
    } else if (
      rainChance !== null &&
      rainChance <= 25 &&
      et0 !== null &&
      et0 >= 3
    ) {
      items.push({
        icon: "≈",
        title: "Tinjau kebutuhan penyiraman",
        text: "Peluang hujan relatif rendah dan evapotranspirasi potensial meningkat. Periksa kondisi tanah dan kebutuhan tanaman sebelum menentukan volume air."
      });
    } else {
      items.push({
        icon: "⌁",
        title: "Sesuaikan irigasi dengan kondisi lahan",
        text: "Gunakan prakiraan hujan sebagai salah satu pertimbangan, lalu periksa kondisi tanah dan kebutuhan tanaman secara langsung."
      });
    }

    if (et0 !== null && et0 >= 4) {
      items.push({
        icon: "☀",
        title: "Evapotranspirasi potensial meningkat",
        text: `ET₀ model sekitar ${numberOrDash(et0, 1)} mm per hari. Nilai ini menggambarkan permintaan evaporatif atmosfer, bukan pengukuran langsung kehilangan air setiap tanaman.`
      });
    } else if (et0 !== null) {
      items.push({
        icon: "◌",
        title: "Pantau perubahan kebutuhan air",
        text: `ET₀ model sekitar ${numberOrDash(et0, 1)} mm per hari. Suhu, angin, dan tutupan awan dapat memengaruhi kebutuhan air di lahan.`
      });
    }

    if (wind !== null && wind >= 20) {
      items.push({
        icon: "↗",
        title: "Perhatikan kecepatan angin",
        text: `Angin sekitar ${numberOrDash(wind, 0)} km/jam. Pertimbangkan risiko hanyut ketika melakukan penyemprotan dan ikuti petunjuk produk yang digunakan.`
      });
    } else if (uv !== null && uv >= 7) {
      items.push({
        icon: "☼",
        title: "Rencanakan waktu kerja luar ruang",
        text: `Indeks UV maksimum diprakirakan ${numberOrDash(uv, 1)}. Pertimbangkan waktu istirahat, tempat teduh, dan perlindungan matahari bagi pekerja.`
      });
    } else {
      items.push({
        icon: "◎",
        title: "Pantau kondisi lapangan",
        text: "Prakiraan dapat berubah. Periksa kembali data sebelum melakukan pekerjaan yang sensitif terhadap cuaca."
      });
    }

    return items.slice(0, 3);
  }

  function renderRecommendations() {
    renderList(
      $("#overviewRecommendations"),
      buildHealthRecommendations()
    );

    renderList(
      $("#farmRecommendations"),
      buildFarmRecommendations(),
      createInsightCard
    );

    const precipitation = asNumber(
      weatherData.daily.precipitation_probability_max?.[0]
    );

    const et0 = asNumber(
      weatherData.daily.et0_fao_evapotranspiration?.[0]
    );

    if (precipitation !== null && precipitation >= 60) {
      setText(
        "#farmHeadline",
        "Peluang hujan perlu diperhitungkan"
      );

      setText(
        "#farmSummary",
        `Peluang hujan harian sekitar ${Math.round(precipitation)}%. Periksa kondisi tanah dan pembaruan prakiraan sebelum menentukan jadwal irigasi.`
      );
    } else if (et0 !== null && et0 >= 4) {
      setText(
        "#farmHeadline",
        "Kehilangan air potensial meningkat"
      );

      setText(
        "#farmSummary",
        "ET₀ membantu menggambarkan permintaan evaporatif atmosfer. Gunakan bersama kondisi tanah, jenis tanaman, dan pengamatan lapangan."
      );
    } else {
      setText(
        "#farmHeadline",
        "Amati cuaca sebelum pekerjaan lapangan"
      );

      setText(
        "#farmSummary",
        "Tidak ada satu variabel yang cukup untuk menentukan kebutuhan irigasi. Kombinasikan prakiraan dengan pengamatan langsung."
      );
    }

    if (!airData?.current?.european_aqi) {
      setText(
        "#searchMessage",
        `Cuaca tersedia untuk ${locationLabel(selectedLocation)}; data kualitas udara belum tersedia.`
      );
    }
  }

  function renderAgriculture() {
    renderFarmWeek();
  }

  function renderFarmWeek() {
    const container = $("#farmWeek");

    if (!container || !weatherData?.daily) return;

    const daily = weatherData.daily;

    container.replaceChildren();

    (daily.time || []).forEach((date, index) => {
      const card = document.createElement("div");
      card.className = "farm-day";

      const day = document.createElement("strong");
      day.textContent = weekdayName(date, index);

      const icon = document.createElement("span");
      icon.className = "farm-day-icon";
      icon.textContent = weatherCodeInfo(
        daily.weather_code?.[index]
      ).icon;

      const temp = document.createElement("b");
      temp.textContent =
        `${temperature(daily.temperature_2m_min?.[index])} / ${temperature(daily.temperature_2m_max?.[index])}`;

      const rain = document.createElement("span");
      rain.textContent =
        `Hujan ${numberOrDash(daily.precipitation_probability_max?.[index])}%`;

      card.append(day, icon, temp, rain);
      container.append(card);
    });
  }

  function renderRecentSearches() {
    const container = $("#recentSearches");

    if (!container) return;

    container.replaceChildren();

    readRecentSearches().forEach(location => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "recent-chip";
      button.textContent = location.name;
      button.title = locationLabel(location);

      button.addEventListener("click", () => {
        loadLocation(location);
      });

      container.append(button);
    });
  }

   // Menampilkan riwayat lokasi yang pernah dicari.
  function renderSearchResults(locations) {
    searchResults.replaceChildren();

    if (!locations.length) {
      const empty = document.createElement("div");
      empty.className = "loading-card";
      empty.textContent =
        "Kota tidak ditemukan. Coba nama atau ejaan lain.";

      searchResults.append(empty);
      searchResults.hidden = false;
      return;
    }

    locations.forEach(location => {
      const button = document.createElement("button");
      button.className = "search-result";
      button.type = "button";
      button.setAttribute("role", "option");

      const copy = document.createElement("span");

      const name = document.createElement("strong");
      name.textContent = location.name;

      const details = document.createElement("small");
      details.textContent =
        [location.admin1, location.country]
          .filter(Boolean)
          .join(", ");

      copy.append(name, details);

      const arrow = document.createElement("span");
      arrow.textContent = "↗";
      arrow.setAttribute("aria-hidden", "true");

      button.append(copy, arrow);

      button.addEventListener("click", () => {
        loadLocation(location);
      });

      searchResults.append(button);
    });

    searchResults.hidden = false;
  }

  function hideSearchResults() {
    searchResults.hidden = true;
    searchResults.replaceChildren();
  }

  // Mencari koordinat kota melalui Open-Meteo Geocoding API.
  async function searchCities(query) {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      showToast("Masukkan nama kota terlebih dahulu.");
      cityInput.focus();
      return;
    }

    if (loading) return;

    lastSearchTerm = normalizedQuery;
    errorBanner.hidden = true;

    setLoading(
      true,
      `Mencari "${normalizedQuery}"…`
    );

    try {
      const url = buildURL(
        "https://geocoding-api.open-meteo.com/v1/search",
        {
          name: normalizedQuery,
          count: 6,
          language: "id",
          format: "json"
        }
      );

      const result = await fetchJSON(url, 12000);

      const locations = (result.results || [])
        .map(item => ({
          name: item.name,
          admin1: item.admin1 || item.admin2 || "",
          country: item.country || "",
          latitude: item.latitude,
          longitude: item.longitude,
          timezone: item.timezone || "auto",
          country_code: item.country_code || ""
        }))
        .filter(item =>
          Number.isFinite(item.latitude) &&
          Number.isFinite(item.longitude)
        );

      setLoading(
        false,
        locations.length
          ? `Ditemukan ${locations.length} kemungkinan lokasi.`
          : "Kota belum ditemukan."
      );

      const exactMatch = locations.find(
        item =>
          item.name.toLowerCase() ===
          normalizedQuery.toLowerCase()
      );

      if (exactMatch) {
        await loadLocation(exactMatch);
        return;
      }

      if (locations.length === 1) {
        await loadLocation(locations[0]);
        return;
      }

      if (locations.length === 0) {
        renderSearchResults([]);
        return;
      }

      renderSearchResults(locations);

      showToast(
        "Pilih kota yang sesuai dari hasil pencarian."
      );
    } catch (error) {
      setLoading(false, "Pencarian kota belum berhasil.");

      errorMessage.textContent =
        error.message ||
        "Layanan pencarian kota tidak tersedia.";

      errorBanner.hidden = false;
    }
  }

  // Berpindah antarbagiannya tanpa memuat ulang halaman.
  function showPage(page) {
    const knownPages = [
      "overview",
      "air",
      "agriculture",
      "about"
    ];

    if (!knownPages.includes(page)) {
      page = "overview";
    }

    knownPages.forEach(key => {
      const section = $(`#view-${key}`);

      if (section) {
        section.hidden = key !== page;
      }
    });

    $$(".nav-link").forEach(button => {
      const active = button.dataset.view === page;

      button.classList.toggle("active", active);

      if (active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });

    if (page === "air" && weatherData) {
      renderAirQuality();
    }

    if (page === "agriculture" && weatherData) {
      renderRecommendations();
      renderFarmWeek();
    }

    closeMobileMenu();

    window.scrollTo({
      top: 0,
      behavior: window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
        ? "auto"
        : "smooth"
    });
  }

  function openMobileMenu() {
    $("#sidebar").classList.add("is-open");
    $("#mobileBackdrop").classList.add("show");

    $("#menuToggle").setAttribute(
      "aria-expanded",
      "true"
    );
  }

  function closeMobileMenu() {
    $("#sidebar").classList.remove("is-open");
    $("#mobileBackdrop").classList.remove("show");

    $("#menuToggle").setAttribute(
      "aria-expanded",
      "false"
    );
  }

  // Memperbarui pilihan Celsius dan Fahrenheit.
  function updateUnitToggle() {
    const isMetric = unitSystem === "metric";
    const spans = $$("#unitToggle span");

    if (spans.length >= 2) {
      spans[0].classList.toggle("unit-active", isMetric);
      spans[1].classList.toggle("unit-active", !isMetric);

      spans[0].setAttribute("aria-label", "Celsius");
      spans[1].setAttribute("aria-label", "Fahrenheit");
    }

    $("#unitToggle").setAttribute(
      "aria-label",
      `Satuan saat ini ${isMetric ? "Celsius" : "Fahrenheit"}; klik untuk beralih`
    );
  }

  function toggleUnits() {
    unitSystem =
      unitSystem === "metric"
        ? "imperial"
        : "metric";

    safeStorageSet(STORAGE_KEYS.units, unitSystem);

    updateUnitToggle();

    if (weatherData) {
      renderAll();
    }

    showToast(
      unitSystem === "metric"
        ? "Satuan diubah ke °C, km/jam, dan mm."
        : "Satuan diubah ke °F, mph, dan inci."
    );
  }

  // Mengganti tema gelap dan terang.
  function toggleTheme() {
    appRoot.classList.toggle("light-mode");

    const isLight =
      appRoot.classList.contains("light-mode");

    safeStorageSet(
      STORAGE_KEYS.theme,
      isLight ? "light" : "dark"
    );

    setText(
      "#themeIcon",
      isLight ? "☼" : "☾"
    );

    $("#themeToggle").setAttribute(
      "aria-label",
      isLight
        ? "Aktifkan mode gelap"
        : "Aktifkan mode terang"
    );
  }

  // Membagikan URL aplikasi.
  async function sharePage() {
    const text =
      `AetherSense — ${locationLabel(selectedLocation)}: ` +
      "cuaca dan kualitas udara dalam satu tempat.";

    try {
      if (navigator.share) {
        await navigator.share({
          title: "AetherSense",
          text,
          url: window.location.href
        });
      } else if (
        navigator.clipboard &&
        window.isSecureContext
      ) {
        await navigator.clipboard.writeText(
          window.location.href
        );

        showToast("Tautan halaman berhasil disalin.");
      } else {
        showToast(
          "Salin tautan dari bilah alamat browser untuk membagikan halaman."
        );
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        showToast(
          "Halaman belum dapat dibagikan dari perangkat ini."
        );
      }
    }
  }

  // Meminta izin sebelum mengambil koordinat perangkat.
  function useCurrentLocation() {
    if (!navigator.geolocation) {
      showToast(
        "Browser ini tidak mendukung lokasi perangkat."
      );
      return;
    }

    if (loading) return;

    setLoading(
      true,
      "Meminta izin lokasi perangkat…"
    );

    navigator.geolocation.getCurrentPosition(
      async position => {
        setLoading(
          false,
          "Lokasi ditemukan. Memuat prakiraan…"
        );

        const location = {
          name: "Lokasi saya",
          admin1: "Koordinat perangkat",
          country: "",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          timezone: "auto"
        };

        await loadLocation(location, {
          remember: false,
          persist: false
        });
      },

      error => {
        setLoading(
          false,
          "Lokasi perangkat tidak dapat digunakan."
        );

        let reason;

        if (error.code === error.PERMISSION_DENIED) {
          reason =
            "Izin lokasi ditolak. Kamu tetap bisa mencari kota secara manual.";
        } else if (error.code === error.TIMEOUT) {
          reason =
            "Permintaan lokasi terlalu lama. Coba lagi atau cari kota secara manual.";
        } else {
          reason =
            "Lokasi tidak dapat ditentukan. Pastikan layanan lokasi aktif.";
        }

        showToast(reason);
        setText("#searchMessage", reason);
      },

      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000
      }
    );
  }

  // Menghasilkan QR code yang mengarah ke URL halaman saat ini.
  function setUpQR() {
    const img = $("#qrImage");
    const fallback = $("#qrFallback");

    if (!img || !fallback) return;

    if (!/^https?:$/.test(window.location.protocol)) {
      fallback.hidden = false;
      fallback.textContent =
        "QR code tersedia setelah aplikasi dipublikasikan.";
      return;
    }

    const qrURL = new URL(
      "https://api.qrserver.com/v1/create-qr-code/"
    );

    qrURL.searchParams.set("size", "180x180");
    qrURL.searchParams.set(
      "data",
      window.location.href
    );
    qrURL.searchParams.set("margin", "4");

    img.addEventListener(
      "load",
      () => {
        img.hidden = false;
        fallback.hidden = true;
      },
      { once: true }
    );

    img.addEventListener(
      "error",
      () => {
        img.hidden = true;
        fallback.hidden = false;
        fallback.textContent =
          "Kode QR tidak dapat dimuat.";
      },
      { once: true }
    );

    img.src = qrURL.toString();
  }

  function initialiseTheme() {
    const savedTheme =
      safeStorageGet(STORAGE_KEYS.theme);

    if (savedTheme === "light") {
      appRoot.classList.add("light-mode");

      setText("#themeIcon", "☼");

      $("#themeToggle").setAttribute(
        "aria-label",
        "Aktifkan mode gelap"
      );
    }
  }

  // Menghubungkan semua tombol dan kontrol dengan fungsinya.
  function bindEvents() {
    searchForm.addEventListener("submit", event => {
      event.preventDefault();
      searchCities(cityInput.value);
    });

    cityInput.addEventListener("input", () => {
      $("#clearSearch").hidden =
        !cityInput.value;
    });

    $("#clearSearch").addEventListener("click", () => {
      cityInput.value = "";
      $("#clearSearch").hidden = true;

      hideSearchResults();
      cityInput.focus();
    });

    $("#locateButton").addEventListener(
      "click",
      useCurrentLocation
    );

    $("#refreshButton").addEventListener(
      "click",
      () => loadLocation(selectedLocation, {
        remember: false
      })
    );

    $("#retryButton").addEventListener(
      "click",
      () => loadLocation(selectedLocation, {
        remember: false
      })
    );

    $("#unitToggle").addEventListener(
      "click",
      toggleUnits
    );

    $("#themeToggle").addEventListener(
      "click",
      toggleTheme
    );

    $("#shareButton").addEventListener(
      "click",
      sharePage
    );

    $("#menuToggle").addEventListener("click", () => {
      if ($("#sidebar").classList.contains("is-open")) {
        closeMobileMenu();
      } else {
        openMobileMenu();
      }
    });

    $("#mobileBackdrop").addEventListener(
      "click",
      closeMobileMenu
    );

    $$("[data-view]").forEach(button => {
      button.addEventListener("click", () => {
        showPage(button.dataset.view);
      });
    });

    $$("[data-view-link]").forEach(link => {
      link.addEventListener("click", event => {
        event.preventDefault();
        showPage(link.dataset.viewLink);
      });
    });

    document.addEventListener("click", event => {
      if (
        !searchResults.hidden &&
        !searchResults.contains(event.target) &&
        !searchForm.contains(event.target)
      ) {
        hideSearchResults();
      }
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        hideSearchResults();
        closeMobileMenu();
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 900) {
        closeMobileMenu();
      }
    });
  }

  // Titik awal aplikasi.
  function init() {
    initialiseTheme();
    updateUnitToggle();
    renderCurrentTime();
    renderRecentSearches();
    bindEvents();
    setUpQR();

    loadLocation(selectedLocation, {
      remember: false
    });
  }

  init();

})();
