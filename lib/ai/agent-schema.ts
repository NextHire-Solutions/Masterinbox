/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/agent-schema.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { z } from "zod";

import {
  parseHandover,
  parseQualification,
  parseSchedule,
  type AgentHandover,
  type AgentQualification,
  type AgentSchedule,
} from "./agent-config";

/*
 * What the config UI is allowed to send, for the five new fields.
 *
 * ---------------------------------------------------------------------------
 * SHARED BY BOTH ROUTES ON PURPOSE
 *
 * POST /reply-agents and PATCH /reply-agents/[id] already carry two copies of
 * the same field list, and they have already drifted once (the PATCH schema
 * allows a null api_key, the POST one does not). Five more fields each would
 * double that. One module, imported twice.
 *
 * ---------------------------------------------------------------------------
 * ZOD CHECKS THE SHAPE; agent-config.ts DECIDES THE MEANING
 *
 * Zod's job here is to reject obvious nonsense at the edge with a useful error
 * message. The normalisers in agent-config.ts still run afterwards, because
 * they are what the drafting path itself uses and because they enforce rules
 * Zod cannot express cheaply — `required` never exceeding the number of
 * questions, an empty business-day list falling back to weekdays, an empty
 * question list disabling the script. Validating twice is the point: the API
 * is not the only way a row can get written.
 */

export const RUN_MODE_VALUES = ["pause", "shadow", "live"] as const;

const TIME = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, e.g. 17:30");

export const scheduleSchema = z.object({
  kind: z.enum(["always", "off_hours"]),
  // IANA zone name. Not enumerated — the list is the platform's, and a bad one
  // is caught by ai/schedule.ts, which holds rather than sends when it cannot
  // read the clock.
  timezone: z.string().min(1).max(64).optional(),
  business_days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  business_start: TIME.optional(),
  business_end: TIME.optional(),
});

export const qualificationSchema = z.object({
  enabled: z.boolean(),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(40).optional(),
        text: z.string().trim().min(1, "A question needs some text").max(400),
      }),
    )
    // Ten is not a limit anyone should reach: the manual flow this reproduces
    // asks three things. It is here to stop a paste accident becoming a
    // twenty-turn interrogation of a real lead.
    .max(10),
  required: z.number().int().min(0).max(10),
  pass_rule: z.enum(["all_answered", "any_answered"]),
});

export const handoverSchema = z.object({
  /*
   * Extra addresses only. The client's introduction contacts are copied in
   * automatically from the client record (see `planHandover`); these are
   * merged on top, so an empty list is the normal, complete configuration.
   */
  cc_emails: z.array(z.string().trim().email("That is not an email address")).max(5),
  /* Optional override of the introduction macro's wording. Empty = the macro. */
  message: z.string().max(4000),
  /*
   * Accepted for backward compatibility only, and ignored: a live introduction
   * is always labelled Introduction after it sends (ai/live.ts). Older screens
   * and stored rows still carry the key.
   */
  mark_introduction: z.boolean().optional(),
});

export const upgradeFieldsSchema = {
  run_mode: z.enum(RUN_MODE_VALUES).optional(),
  client_ids: z.array(z.string().uuid()).max(100).optional(),
  schedule: scheduleSchema.optional(),
  qualification: qualificationSchema.optional(),
  handover: handoverSchema.optional(),
};

/** Wire shape → the parsed values `saveAgent` wants. Undefined stays undefined. */
export function normaliseUpgradeFields(data: {
  schedule?: unknown;
  qualification?: unknown;
  handover?: unknown;
}): {
  schedule?: AgentSchedule;
  qualification?: AgentQualification;
  handover?: AgentHandover;
} {
  return {
    schedule: data.schedule === undefined ? undefined : parseSchedule(data.schedule),
    qualification:
      data.qualification === undefined ? undefined : parseQualification(data.qualification),
    handover: data.handover === undefined ? undefined : parseHandover(data.handover),
  };
}
