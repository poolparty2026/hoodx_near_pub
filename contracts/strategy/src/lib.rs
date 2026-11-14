//! Poolside strategy contract (ARCHITECTURE section 5). Built up in slices, each audited:
//! slice 1 is the pure validation of `new`'s configuration and public limits (`limits`);
//! slice 2 is the on-chain `new`, its storage registrations and their callbacks (`contract`);
//! slice 3 is funding: `ft_on_transfer`, `cancel`, `withdraw` and the operation lock
//! (`contract::funding`); `price` is the exact price arithmetic `start`, `agent_swap` and the
//! deploy cap share with `packages/rules`.
pub mod contract;
pub mod limits;
pub mod price;
