import type { ModelCallAccounting } from './accounting';
import type { InternalModelProfile } from './profiles';
import type { StructuredTransport } from './structured';

export type InternalModelContext = {
  profile: InternalModelProfile;
  accounting: ModelCallAccounting;
  transport?: StructuredTransport;
};
