#
# Copyright (C) 2006-2017 OpenWrt.org
# Copyright (C) 2022-2025 sirpdboy <herboy2008@gmail.com>
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-timecontrol
PKG_VERSION:=1.0
PKG_RELEASE:=20260601
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=sirpdboy <herboy2008@gmail.com>

LUCI_TITLE:=LuCI support for Internet time control
LUCI_DESCRIPTION:=LuCI support for Internet time control based on nftables.
LUCI_DEPENDS:=+nftables +kmod-nft-bridge
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/timecontrol
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || rm -f /tmp/luci-indexcache
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
