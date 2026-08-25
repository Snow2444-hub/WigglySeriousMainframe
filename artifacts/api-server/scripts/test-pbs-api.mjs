const url = "https://data-api.health.gov.au/pbs/api/v3";
const subscriptionKey = process.env.PBS_SUBSCRIPTION_KEY;

if (!subscriptionKey) {
  console.error("PBS_SUBSCRIPTION_KEY is not configured in Replit Secrets.");
  process.exit(1);
}

const response = await fetch(url, {
  headers: {
    Accept: "application/json",
    "Subscription-Key": subscriptionKey,
  },
});

console.log(`HTTP status: ${response.status} ${response.statusText}`);
for (const header of [
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
]) {
  console.log(`${header}: ${response.headers.get(header) ?? "(not returned)"}`);
}