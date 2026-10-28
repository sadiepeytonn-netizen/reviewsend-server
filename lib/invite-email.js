// The "set your password" email. Same design as before; the business name is
// now HTML-escaped so nothing typed into a name can inject content into an
// email sent from noreply@reviewsend.io.

const escapeHtml = s => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function inviteEmailHtml(businessName, setupLink) {
  const name = escapeHtml(businessName);
  const link = escapeHtml(setupLink);
  return `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; background: #F4F7FB;">
            <div style="background: #fff; border-radius: 16px; padding: 40px; border: 1px solid #D6E2F0;">
              <div style="text-align: center; margin-bottom: 32px;">
                <div style="font-size: 13px; font-weight: 600; letter-spacing: 5px; color: #1A5FBF; text-transform: uppercase;">★ ReviewSend</div>
              </div>
              <h1 style="font-size: 26px; font-weight: 700; color: #0D1117; margin: 0 0 12px;">Set Your Password</h1>
              <p style="font-size: 15px; color: rgba(13,17,23,0.6); line-height: 1.7; margin: 0 0 16px;">
                Use the button below to set (or reset) the password for <strong>${name}</strong>'s ReviewSend account.
              </p>
              <p style="font-size: 15px; color: rgba(13,17,23,0.6); line-height: 1.7; margin: 0 0 32px;">
                This link expires in <strong>24 hours</strong>. If you didn't request this, you can safely ignore this email.
              </p>
              <div style="text-align: center; margin-bottom: 28px;">
                <a href="${link}" style="display: inline-block; background: #1A5FBF; color: #fff; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 600; text-decoration: none;">
                  Set My Password →
                </a>
              </div>
              <div style="background: #F4F7FB; border-radius: 10px; padding: 14px 18px; margin-bottom: 24px;">
                <p style="font-size: 12px; font-weight: 600; color: rgba(13,17,23,0.5); margin: 0 0 6px;">Button not working? Copy and paste this link into your browser:</p>
                <p style="font-size: 11px; color: rgba(13,17,23,0.4); margin: 0; word-break: break-all;">${link}</p>
              </div>
              <p style="font-size: 13px; color: rgba(13,17,23,0.4); text-align: center; margin: 0;">
                Questions? Email us at support.reviewsend@gmail.com
              </p>
            </div>
          </div>
        `;
}

module.exports = { inviteEmailHtml, escapeHtml };
