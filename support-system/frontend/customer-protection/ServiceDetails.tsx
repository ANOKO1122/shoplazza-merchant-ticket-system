import { useEffect, useId, useRef } from 'react';
import { attachInfoPopover, serviceDetails, serviceWindowRules, type ServicePolicyBasis } from './service-details';
import { Icon } from './shared';

export function ServiceDetails({ basis }: { basis?: ServicePolicyBasis }) {
  const rules = serviceWindowRules(basis);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => button.current && panel.current ? attachInfoPopover(button.current, panel.current) : undefined, []);
  return <div className="cp-service-info"><button type="button" ref={button} className="cp-info-button" aria-label="About Shipping Protection" aria-expanded="false" aria-controls={id} aria-haspopup="dialog"><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 10v7M12 6.5v1.5" /></svg></button><div ref={panel} id={id} role="dialog" aria-labelledby={id + '-title'} className="cp-service-popover" popover="manual" hidden><div className="cp-service-popover-heading"><h3 id={id + '-title'}>{serviceDetails.title}</h3><button type="button" data-sp-info-close className="cp-icon-button" aria-label="Close service details"><Icon name="close" size={18} /></button></div><p>{serviceDetails.introduction}</p><ul>{serviceDetails.issues.map(issue => <li key={issue.key}><strong>{issue.title}</strong><span>{issue.description}</span>{rules[issue.key] && <span className="cp-service-window-rule">{rules[issue.key]}</span>}</li>)}</ul><p className="cp-muted">{serviceDetails.completionNote}</p><p className="cp-muted">{serviceDetails.footer}</p></div></div>;
}
