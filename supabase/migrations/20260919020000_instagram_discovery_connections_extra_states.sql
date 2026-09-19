-- =============================================================================
-- Extends instagram_discovery_connections.status with two states the real
-- Hermes browser runtime (src/lib/instagram-discovery, hermes-browser-runtime/)
-- reports and this table previously had no room for:
--
-- - 'ready':              the runtime has opened this organization's dedicated
--                          Chromium profile and it is authenticated and idle —
--                          distinct from 'connected', which is set the moment a
--                          first-time manual login succeeds. Both mean "usable
--                          for discovery"; 'ready' is what a later run reports
--                          on an already-authenticated profile without a fresh
--                          login event to attach a username to.
-- - 'browser_unavailable': the runtime itself could not launch/reach local
--                          Chromium for this profile (crashed browser, missing
--                          executable, disk/profile corruption) — a runtime
--                          infrastructure failure, distinct from 'error' (an
--                          Instagram-side failure, e.g. a login challenge) so
--                          Settings can show an operator the right kind of
--                          problem.
-- =============================================================================
alter table public.instagram_discovery_connections
  drop constraint instagram_discovery_connections_status_check;

alter table public.instagram_discovery_connections
  add constraint instagram_discovery_connections_status_check
  check (status in ('authentication_required', 'connecting', 'connected', 'session_expired', 'browser_unavailable', 'ready', 'error'));
