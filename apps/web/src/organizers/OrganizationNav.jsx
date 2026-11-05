import React from 'react';
import { NavLink } from 'react-router-dom';
export function OrganizationNav({ organizationId }) {
  return <nav className="organization-nav" aria-label="Organization workspace">
    <NavLink end to={`/organizers/${organizationId}`}>Events</NavLink>
    <NavLink to={`/organizers/${organizationId}/venues`}>Venues & seating</NavLink>
  </nav>;
}
