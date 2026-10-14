export interface SampleBrief {
  name: string
  brief: string
}

const COMMON =
  ' Make concrete, checkable claims (numbers, owners, dates, thresholds) a reviewer could question. ' +
  'Keep the file compact: under 15 KB total, one small <style> block, no external assets.'

export const SAMPLE_BRIEFS: SampleBrief[] = [
  {
    name: 'Release readiness review',
    brief:
      'Release readiness review for checkout-service v2.4: rewritten card-vault retry logic and a new idempotency key on the capture path. ' +
      'Sections: summary, scope of change, error budget status, rollback plan, open incidents, monitoring gaps, go/no-go recommendation with a decision deadline.' + COMMON,
  },
  {
    name: 'Incident postmortem',
    brief:
      'Blameless incident postmortem for a 47-minute payment-processing outage caused by a connection-pool exhaustion after a config deploy. ' +
      'Sections: impact (user-facing minutes, failed transaction count, revenue estimate), timeline with timestamps, root cause, what went well, what went badly, ' +
      'action items with named owners and due dates.' + COMMON,
  },
  {
    name: 'Architecture decision record',
    brief:
      'Architecture decision record: replace our in-house cron scheduler with Temporal for the payments team. ' +
      'Sections: context and current pain (missed-run rate, debug cost), options considered (keep, Temporal self-hosted, Temporal Cloud, Step Functions) with rough cost estimates, ' +
      'decision, consequences, migration plan with two milestones, and the conditions under which we would revisit.' + COMMON,
  },
  {
    name: 'Product spec',
    brief:
      'Product spec for "split payments" in the merchant checkout: buyers split one order across two payment methods. ' +
      'Sections: problem and evidence, goals, explicit non-goals, UX flow, API changes, failure modes (partial authorization, refunds across two methods), ' +
      'rollout plan with a 5 percent flag ramp, and the success metric with its target number.' + COMMON,
  },
  {
    name: 'Churn analysis report',
    brief:
      'Q3 churn analysis for a B2B SaaS onboarding flow. Cohorts: self-serve vs sales-assisted, 14-day vs annual trial. ' +
      'Sections: headline churn rate with prior-quarter comparison, cohort breakdown with counts, top three exit reasons from cancellation surveys with percentages, ' +
      'a cost-of-fix estimate per recommendation, and three recommendations ranked by expected impact.' + COMMON,
  },
  {
    name: 'QA findings report',
    brief:
      'QA findings for the marketing site redesign before launch. Sections: scope and browsers tested, blocking issues (broken pricing-table CTA on mobile Safari, ' +
      'contrast failure on the hero banner, missing alt text on the logo wall), non-blocking issues with severity, performance budget results (LCP, CLS per page), ' +
      'and a launch recommendation with sign-off conditions.' + COMMON,
  },
]
