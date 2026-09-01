-- 0075_backfill_hired_at_confirmed.sql
--
-- Backfill client_pipeline_entries.hired_at for agents hired BEFORE the 0059
-- hired_at trigger existed, so the dashboard stops falling back to updated_at
-- (which drifts on any later edit) for the hire date.  See the follow-up-time /
-- Client Health "Last Hire" bug: e.g. Douglas Elliman NYC read Aug 19 (a later
-- edit) instead of the true Jul 7 hire.
--
-- Each date below is a CONFIRMED value, not a guess:
--   * source=slack     -> exact send time of the '🎉 Agent hired' Slack post
--                          (the real moment the agent was marked hired).
--   * source=event-log -> pipeline_outcome_events.occurred_at, the append-only
--                          funnel log (validated: matched Slack to the day for
--                          24 of 25 agents we could cross-check).
-- Demo client and the 2 rows with no recorded hire event are intentionally omitted.
--
-- SAFETY (portal + inbox are in live client use): writes ONLY hired_at, and ONLY
-- where it is currently NULL and stage='hired' (idempotent, re-runnable).
--   * 0059 (BEFORE): its overwrite branch needs old.stage <> 'hired'; these rows
--     are already 'hired', so our explicit value is kept, not clobbered.
--   * 0065 (AFTER): logs a funnel event only on a stage change - none here.
--   * 0061 (BEFORE): stamps client_activity_at only when stage/name/email/etc.
--     change - hired_at is not in that list, so it stays untouched.
--   * 0070 (AFTER): returns immediately unless stage='no_show'.
--   * No trigger writes updated_at, so it stays frozen (no stagnant-intro drift).
--   * n8n / FollowUp Boss / Slack fire from app routes, NOT DB triggers, so this
--     pure-SQL update notifies nothing.

update public.client_pipeline_entries e
set hired_at = v.hired_at
from (values
  ('fa02168c-2563-440b-bedb-47c14bc785c9'::uuid, '2026-06-01T15:45:00.322+00:00'::timestamptz),  -- event-log | 54 Realty | realtorwe@gmail.com
  ('4128b877-c7f8-42cb-931f-2c5a0ed144d1'::uuid, '2026-06-01T15:45:55.305+00:00'::timestamptz),  -- event-log | 54 Realty | teamdamschen@gmail.com
  ('fa7ea6f1-c1ad-47aa-a313-ae203c26a447'::uuid, '2026-06-30T12:45:40+00:00'::timestamptz),  -- slack     | BHGRE Basecamp | ann@ryansanfordteam.com
  ('d06ec919-4586-4f82-81a6-70e2db73bb47'::uuid, '2026-07-08T14:27:39+00:00'::timestamptz),  -- slack     | BHGRE Basecamp | dledney@comcast.net
  ('3abf4f8c-8752-44bf-98ab-b9601519cf63'::uuid, '2026-07-18T14:54:09+00:00'::timestamptz),  -- slack     | BHGRE Basecamp | lynneanneholley@kw.com
  ('d655ab85-847e-4a51-9ddf-c2a7661ac87f'::uuid, '2026-06-23T18:54:27.683+00:00'::timestamptz),  -- event-log | C21 Results - Elite Team | tatum@mccurdyre.com
  ('49662490-8b14-47e8-af94-6821d07de9b1'::uuid, '2026-07-08T15:26:51+00:00'::timestamptz),  -- slack     | C21 Results - Elite Team | klove.businessprofessional@gmail.com
  ('88dcbf0c-7472-42df-8da8-768625a13626'::uuid, '2026-07-08T18:02:35.688+00:00'::timestamptz),  -- event-log | C21 Results - Elite Team | mtillmanre@gmail.com
  ('84889e5f-f262-4cb2-9b1a-0a2477855bf3'::uuid, '2026-06-04T17:10:08.191+00:00'::timestamptz),  -- event-log | Camelot Realty Group | vuongstrong@gmail.com
  ('8c84995a-f11c-432e-b9f5-9564c3e67270'::uuid, '2026-07-07T15:13:54+00:00'::timestamptz),  -- slack     | Douglas Elliman NYC | gustcarth@gmail.com
  ('05474b30-2aa6-46f3-8759-695a4f2ad5d2'::uuid, '2026-06-05T04:48:31.759+00:00'::timestamptz),  -- event-log | Howe Realty Group | susan.huser.re@gmail.com
  ('28a12e27-5480-493c-9555-09608837c8ca'::uuid, '2026-06-05T05:19:47.773+00:00'::timestamptz),  -- event-log | Howe Realty Group | yesy.ripley@btgrealestate.com
  ('4757a33d-c900-49d1-b7c7-45369091090b'::uuid, '2026-06-08T17:13:07.725+00:00'::timestamptz),  -- event-log | Howe Realty Group | mdreher2606@gmail.com
  ('b68aa07f-0f69-4f1d-a8c8-e8b306bcb21e'::uuid, '2026-06-08T17:14:46.92+00:00'::timestamptz),  -- event-log | Howe Realty Group | thania@chhaz.org
  ('1be60f75-f71c-4925-b5a4-0bef1af407bf'::uuid, '2026-06-10T16:54:15.336+00:00'::timestamptz),  -- event-log | Howe Realty Group | jmgaruff@yahoo.com
  ('2668b49b-2297-49d1-b3b7-5b6166a4ebd3'::uuid, '2026-06-11T21:38:28.038+00:00'::timestamptz),  -- event-log | Howe Realty Group | sharlisegalindo@gmail.com
  ('ade5b542-07c3-4510-958c-8dfdeb433c80'::uuid, '2026-06-17T18:12:24.387+00:00'::timestamptz),  -- event-log | Howe Realty Group | cinthiarealtoraz@gmail.com
  ('107a5826-1fcb-4225-977a-1378e901bb81'::uuid, '2026-06-19T23:21:30.691+00:00'::timestamptz),  -- event-log | Howe Realty Group | Courtneyclayter21@gmail.com
  ('2a184308-812f-4fc0-bd7f-1b32b05f18dd'::uuid, '2026-06-22T19:31:14.574+00:00'::timestamptz),  -- event-log | Howe Realty Group | DhillonAlamshaw@yahoo.com
  ('57284f36-e2f9-4aca-959b-b62d392b7786'::uuid, '2026-07-02T17:15:08+00:00'::timestamptz),  -- slack     | Howe Realty Group | kaylah_a@yahoo.com
  ('c8787fe0-95f5-4231-a341-0bd9412d9882'::uuid, '2026-07-06T16:37:58+00:00'::timestamptz),  -- slack     | Howe Realty Group | Yantis1@live.com
  ('a28fbcc6-0db5-46b6-b867-f9a3e4d15f6c'::uuid, '2026-07-10T22:05:59+00:00'::timestamptz),  -- slack     | Howe Realty Group | Elidabarnes@icloud.com
  ('1d6e9b97-253a-4d1d-83b5-b0f334d7c4f3'::uuid, '2026-07-10T22:09:25+00:00'::timestamptz),  -- slack     | Howe Realty Group | Erin Morris
  ('17fceb3b-67f7-4858-9a39-6801f090cc71'::uuid, '2026-07-13T16:39:30+00:00'::timestamptz),  -- slack     | Howe Realty Group | Alexa Redondo
  ('803267a3-ddb5-4248-becc-b8f57d6bb4ff'::uuid, '2026-07-14T17:10:08+00:00'::timestamptz),  -- slack     | Howe Realty Group | shannonnwestt@gmail.com
  ('e20e0668-8743-49ed-bb17-c303ec8f9692'::uuid, '2026-07-14T23:23:49+00:00'::timestamptz),  -- slack     | Howe Realty Group | basiamaxwell@gmail.com
  ('18f0e4ee-e0c0-4246-85e4-70a5ff9e04e8'::uuid, '2026-07-16T17:13:09+00:00'::timestamptz),  -- slack     | Howe Realty Group | ipiriye@protonmail.com
  ('fc4bde9b-80ae-48db-834f-f57fefb1cfd5'::uuid, '2026-07-20T16:18:10+00:00'::timestamptz),  -- slack     | Howe Realty Group | LoLo1605@sbcglobal.net
  ('f9feef1d-9b8c-4c52-a495-3b22e3b68614'::uuid, '2026-07-20T18:51:56+00:00'::timestamptz),  -- slack     | Howe Realty Group | 44white@gmail.com
  ('73ffaf76-1272-474c-b549-d7f98ae13877'::uuid, '2026-07-21T23:43:11+00:00'::timestamptz),  -- slack     | Howe Realty Group | assistancebybrown@gmail.com
  ('20eb7bf1-cb19-4e83-8d59-f060ee6c29fb'::uuid, '2026-07-22T17:26:10+00:00'::timestamptz),  -- slack     | Howe Realty Group | mvdimichvel1616@gmail.com
  ('df6f5dc2-c338-4ba8-ac2b-1133f54f4fde'::uuid, '2026-07-27T18:04:46+00:00'::timestamptz),  -- slack     | Howe Realty Group | Laurie Yantis
  ('a7aabb64-b330-4af7-ae9e-2e88ef665aa0'::uuid, '2026-07-27T21:57:51+00:00'::timestamptz),  -- slack     | Howe Realty Group | sjackson.shelby@gmail.com
  ('ec7a4932-343c-4a24-aabc-07b6969a2240'::uuid, '2026-07-20T21:14:20+00:00'::timestamptz),  -- slack     | Hunter Dehn Realty | arsilopez@gmail.com
  ('3a7fd975-2377-4187-a5f1-d73f0e4d447d'::uuid, '2026-06-12T14:37:33.31+00:00'::timestamptz),  -- event-log | Kelly + Co | jojo@jojomaguiredesign.com
  ('51e4b8fc-fe88-46b9-9784-d3babf838314'::uuid, '2026-06-16T15:32:55.436+00:00'::timestamptz),  -- event-log | MattC Group | samaysrealtor@gmail.com
  ('06b3bb14-ecc9-4113-af30-cf5445c837db'::uuid, '2026-06-18T17:42:47.309+00:00'::timestamptz),  -- event-log | PRG Real Estate at EXP | latriseedwards@gmail.com
  ('bfff13ec-a5f6-43c5-8b22-26ca0664fcb1'::uuid, '2026-06-18T17:42:55.443+00:00'::timestamptz),  -- event-log | PRG Real Estate at EXP | singhxsharan@gmail.com
  ('dca46cf0-ea42-4171-93ee-868ad9762296'::uuid, '2026-06-15T23:49:08.723+00:00'::timestamptz),  -- event-log | SERHANT. NJ | srcrealtornj@gmail.com
  ('0fc448df-33d7-4c36-9a88-eacd6024aaa9'::uuid, '2026-07-08T17:11:42+00:00'::timestamptz),  -- slack     | SERHANT. NJ | nbruno@christiesrealestategroup.com
  ('7fcdcb38-db69-4f96-94f3-8687fcfd64cb'::uuid, '2026-06-12T15:30:55.413+00:00'::timestamptz),  -- event-log | The Discover Phx Team | seanqueenazre@gmail.com
  ('c51c4b48-7127-4a87-8cd1-9e69541e8fc3'::uuid, '2026-06-18T18:09:47.746+00:00'::timestamptz),  -- event-log | The Discover Phx Team | harry@patelgroupaz.com
  ('35989cc8-46ca-497d-834a-459c24fd65a8'::uuid, '2026-07-15T21:29:41+00:00'::timestamptz),  -- slack     | The Discover Phx Team | estratton30@gmail.com
  ('a509339e-7595-432c-89ee-68111c97e1c5'::uuid, '2026-07-23T23:44:39+00:00'::timestamptz),  -- slack     | The Discover Phx Team | alexismovesaz@gmail.com
  ('1fab5971-acd4-46c1-8373-13133b7f25a5'::uuid, '2026-06-03T11:56:15.356+00:00'::timestamptz),  -- event-log | The Keyes Company | robertkrasow@gmail.com
  ('cca9ccb1-50a6-48cb-9daf-2da60b59ed49'::uuid, '2026-06-03T11:56:50.253+00:00'::timestamptz),  -- event-log | The Keyes Company | espypastran@gmail.com
  ('279382cb-b70f-47c0-bcc2-792895e06b60'::uuid, '2026-06-18T18:51:31.078+00:00'::timestamptz),  -- event-log | The Keyes Company | heatherharrishomes@gmail.com
  ('44ed52d1-65be-4f1b-b92c-e3360849b398'::uuid, '2026-06-18T18:56:14.694+00:00'::timestamptz),  -- event-log | The Keyes Company | pstamp777@gmail.com
  ('1ae94815-cc3d-4a07-9040-0e160b59e0d3'::uuid, '2026-07-14T17:43:50+00:00'::timestamptz),  -- slack     | The Keyes Company | avirijevic@gmail.com
  ('fd6e7faf-ccec-4605-801a-4088141137b2'::uuid, '2026-07-01T02:25:45+00:00'::timestamptz)  -- slack     | The Rafeh Group | niokamg@gmail.com
) as v(id, hired_at)
where e.id = v.id
  and e.stage = 'hired'
  and e.hired_at is null;
