# Integrations

## Twilio

Set secrets only after the Worker exists:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_PHONE_NUMBER
npx wrangler secret put PUBLIC_BASE_URL
```

`PUBLIC_BASE_URL` is the deployed HTTPS origin without a trailing slash. The provider sends its status callback to `/api/twilio/status`. The endpoint validates `X-Twilio-Signature`, records callback identity, ignores duplicates, and maps `delivered`, `failed`, and `undelivered` independently. Full phone/email values remain in D1 and are masked in responses; they are never logged by StoreResolve.

## Controlled first SMS

1. Deploy and verify `FAMILY_PILOT`.
2. Leave external notifications disabled.
3. In Pilot controls, configure one owner with E.164 phone, email, Active, and SMS enabled.
4. Add all four Twilio/URL secrets and redeploy.
5. Verify the page shows provider `READY` and the masked destination.
6. Manually enable external notifications.
7. Select exactly that one owner, check the explicit confirmation, and send once.
8. Wait for the notification to move from `SENT` to `DELIVERED`, `FAILED`, or `UNDELIVERED` through the callback.
9. Turn the kill switch off again while reviewing results.

The page has no manager or send-to-all target and rate-limits each recipient to one test per five minutes.

## Gmail

`ComplaintEmailProvider` remains an interface only. No Gmail inbox, push notification, Pub/Sub subscription, or real acknowledgment is connected in this milestone.
