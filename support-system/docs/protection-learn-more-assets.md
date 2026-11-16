# Learn more public assets

The parcel photograph in `public/assets/protection-parcel-hero.webp` was generated with the built-in imagegen tool on 2026-11-16 for this project. It is a decorative illustration of parcel delivery, not a customer testimonial or proof of an actual shipment. The selected 1536×1024 image was resized to 1200×800 and encoded as WebP using Sharp (quality 84, 55 KB).

Generation prompt:

> Create a polished editorial lifestyle photograph for an ecommerce Shipping Protection information modal. Landscape 3:2 composition. A neatly sealed small kraft cardboard delivery parcel resting on a warm pale oak entrance console, a person's hands gently receiving it from the right edge, soft daylight, a subtle navy sleeve, warm trustworthy natural atmosphere, contemporary home background softly blurred. Main parcel and hands placed in the right half, left half uncluttered darker deep navy soft shadow with negative space for white heading overlay. Professional authentic photography, realistic hands and cardboard texture, restrained premium aesthetic. No text, no logos, no symbols, no watermark, no shipping label personal information. Image must work as a wide crop banner on desktop and compact wide banner on mobile.

The privacy page at `/protection/privacy` describes the existing order/request data, optional location and camera flows, browser storage and service contact. It does not introduce tracking or change data processing. Its structure was checked against the [ICO privacy information checklist](https://ico.org.uk/for-organisations/advice-for-small-organisations/checklists/data-protection-self-assessment-checklist/be-transparent-about-how-you-use-peoples-data/). No fixed retention period, registered trademark, third-party endorsement or certification is claimed.

Deployment: allow only the two exact new public paths in the Express boundary and both customer nginx configurations. Keep all other customer-host allowlist restrictions. The existing request-window text and backend calculation are outside this change.
