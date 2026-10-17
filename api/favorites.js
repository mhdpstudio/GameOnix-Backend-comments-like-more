
const AUTH_API_URL = "https://gameonix-backend.vercel.app/api/auth/me";
const FAVORITES_API_URL = "https://gameonixfav.vercel.app/api/favorites";

async function getAccessToken() {
  const response = await fetch(`${AUTH_API_URL}?token=true`, {
    method: "GET",
    credentials: "include",
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.token) {
    throw new Error(data.error || "Please log in to manage favorites.");
  }

  return data.token;
}

async function request(method, slug) {
  const token = await getAccessToken();

  const response = await fetch(FAVORITES_API_URL, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(slug ? { "Content-Type": "application/json" } : {}),
    },
    ...(slug ? { body: JSON.stringify({ slug }) } : {}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Favorites request failed.");
  }

  return data;
}

export function getFavorites() {
  return request("GET");
}

export function addFavorite(slug) {
  return request("POST", slug);
}

export function removeFavorite(slug) {
  return request("DELETE", slug);
}
