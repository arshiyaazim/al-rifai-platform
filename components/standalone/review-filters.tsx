import Link from 'next/link';
import {REVIEW_CATEGORIES, REVIEW_DOMAINS, REVIEW_STATES} from '@/lib/review-ui';

type Props = {
  state: string;
  domain: string;
  category: string;
  q: string;
  mine: boolean;
};

/**
 * Server-rendered filter form. Uses the existing workspace form styles and
 * keeps the filter state in the URL so the queue is shareable and reload-safe.
 */
export function ReviewFilters({state, domain, category, q, mine}: Props) {
  return (
    <form method="get" className="card form" style={{marginBottom: 18}}>
      <div className="grid">
        <label>
          <span>State</span>
          <select name="state" defaultValue={state}>
            {REVIEW_STATES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label>
          <span>Domain</span>
          <select name="domain" defaultValue={domain}>
            <option value="ALL">All domains</option>
            {REVIEW_DOMAINS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label>
          <span>Category</span>
          <select name="category" defaultValue={category}>
            <option value="ALL">All categories</option>
            {REVIEW_CATEGORIES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label>
          <span>Search</span>
          <input name="q" defaultValue={q} placeholder="id, target, source message, raw text" />
        </label>
        <label style={{justifyContent: 'flex-end'}}>
          <span>Only mine</span>
          <input type="checkbox" name="mine" value="1" defaultChecked={mine} />
        </label>
      </div>
      <div className="row-actions">
        <button type="submit">Apply filters</button>
        <Link href="/review">Clear</Link>
      </div>
    </form>
  );
}
